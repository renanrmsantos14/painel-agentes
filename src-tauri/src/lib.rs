mod pending;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_COMMITS: usize = 6;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Pr {
    number: u64,
    url: String,
    state: String,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct GitInfo {
    project: String,
    repo_root: String,
    branch: String,
    base: String,
    on_base: bool,
    branch_exists: bool,
    worktree: bool,
    worktree_missing: bool,
    ahead: u32,
    behind: u32,
    merged: bool,
    commits: Vec<String>,
    commit_count: u32,
    files: u32,
    insertions: u32,
    deletions: u32,
    dirty: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    id: String,
    agent: &'static str,
    title: String,
    cwd: String,
    created_at: i64,
    updated_at: i64,
    archived: bool,
    state: Option<String>,
    detail: Option<String>,
    needs_action: Option<String>,
    prs: Vec<Pr>,
    git: Option<GitInfo>,
    open_url: String,
}

struct Seed {
    run: Run,
    /// Pastas candidatas, em ordem: worktree da sessão e depois a pasta de origem.
    dirs: Vec<String>,
    branch: Option<String>,
    base: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn clean_path(p: &str) -> String {
    p.trim_start_matches(r"\\?\").to_string()
}

fn same_path(a: &str, b: &str) -> bool {
    let n = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_lowercase();
    n(a) == n(b)
}

// ---------- Fontes de sessões ----------

fn claude_seeds(since: i64, archived: bool) -> Vec<Seed> {
    let Some(appdata) = std::env::var_os("APPDATA") else { return vec![] };
    let root = PathBuf::from(appdata).join("Claude").join("claude-code-sessions");
    let mut out = vec![];
    let dirs = |p: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(p).map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default()
    };
    for org in dirs(&root) {
        for acct in dirs(&org) {
            let Ok(entries) = std::fs::read_dir(&acct) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !name.starts_with("local_") || !name.ends_with(".json") {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                let updated = v.get("lastActivityAt").and_then(Value::as_i64).unwrap_or(0);
                let is_archived = v.get("isArchived").and_then(Value::as_bool).unwrap_or(false);
                if updated < since || (is_archived && !archived) {
                    continue;
                }
                let Some(id) = str_of(&v, "sessionId") else { continue };
                let cwd = str_of(&v, "cwd").unwrap_or_default();
                let mut dirs = vec![];
                if let Some(w) = str_of(&v, "worktreePath") {
                    dirs.push(w);
                }
                dirs.push(cwd.clone());
                if let Some(o) = str_of(&v, "originCwd") {
                    dirs.push(o);
                }

                let summary = v.get("postTurnSummary");
                // O resumo só vale se descreve a última resposta do agente.
                let current = match (str_of(&v, "postTurnSummaryFor"), str_of(&v, "lastAssistantUuid")) {
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                };
                let pick = |k: &str| if current { summary.and_then(|s| str_of(s, k)) } else { None };

                let prs = v
                    .get("prs")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|p| Pr {
                                number: p.get("prNumber").and_then(Value::as_u64).unwrap_or(0),
                                url: str_of(p, "url").unwrap_or_default(),
                                state: str_of(p, "state").unwrap_or_default(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                out.push(Seed {
                    run: Run {
                        open_url: format!("claude://code/continue?session={id}"),
                        id,
                        agent: "claude",
                        title: str_of(&v, "title").unwrap_or_else(|| "Sem título".into()),
                        cwd,
                        created_at: v.get("createdAt").and_then(Value::as_i64).unwrap_or(updated),
                        updated_at: updated,
                        archived: is_archived,
                        state: pick("status_category"),
                        detail: pick("status_detail"),
                        needs_action: pick("needs_action"),
                        prs,
                        git: None,
                    },
                    dirs,
                    branch: str_of(&v, "branch"),
                    base: str_of(&v, "sourceBranch"),
                });
            }
        }
    }
    out
}

fn codex_seeds(since: i64, archived: bool) -> Vec<Seed> {
    let Some(home) = std::env::var_os("USERPROFILE") else { return vec![] };
    let db = PathBuf::from(home).join(".codex").join("state_5.sqlite");
    let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return vec![];
    };
    let sql = "select id, cwd, coalesce(nullif(name,''), nullif(title,''), 'Sem título'), git_branch, archived,
                      coalesce(created_at_ms, created_at*1000), coalesce(updated_at_ms, updated_at*1000)
               from threads
               where (thread_source is null or thread_source = 'user') and agent_role is null
                 and coalesce(updated_at_ms, updated_at*1000) >= ?1 and (?2 or archived = 0)";
    let Ok(mut stmt) = conn.prepare(sql) else { return vec![] };
    let rows = stmt.query_map((since, archived), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
        ))
    });
    let Ok(rows) = rows else { return vec![] };
    rows.flatten()
        .map(|(id, cwd, title, branch, arch, created, updated)| {
            let cwd = clean_path(&cwd);
            Seed {
                run: Run {
                    open_url: format!("codex://threads/{id}"),
                    id,
                    agent: "codex",
                    title: title.lines().next().unwrap_or("").trim().to_string(),
                    cwd: cwd.clone(),
                    created_at: created,
                    updated_at: updated,
                    archived: arch != 0,
                    state: None,
                    detail: None,
                    needs_action: None,
                    prs: vec![],
                    git: None,
                },
                dirs: vec![cwd],
                branch: branch.filter(|b| !b.is_empty()),
                base: None,
            }
        })
        .collect()
}

// ---------- Git ----------

fn git_cmd(dir: &str, args: &[&str]) -> Command {
    let mut c = Command::new("git");
    c.arg("-C").arg(dir).args(["-c", "core.quotepath=false"]).args(args).env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

fn git(dir: &str, args: &[&str]) -> Option<String> {
    let o = git_cmd(dir, args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn git_ok(dir: &str, args: &[&str]) -> bool {
    git_cmd(dir, args).output().map(|o| o.status.success()).unwrap_or(false)
}

/// Soma `--numstat` (arquivos únicos, linhas adicionadas e removidas).
fn numstat(out: &str) -> (Vec<String>, u32, u32) {
    let (mut files, mut ins, mut del) = (vec![], 0, 0);
    let mut seen = HashSet::new();
    for line in out.lines() {
        let mut p = line.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (p.next(), p.next(), p.next()) else { continue };
        ins += a.parse::<u32>().unwrap_or(0);
        del += d.parse::<u32>().unwrap_or(0);
        if seen.insert(path.to_string()) {
            files.push(path.to_string());
        }
    }
    (files, ins, del)
}

/// Dados por pasta e por repositório, lidos uma vez por varredura (vários chats dividem a mesma pasta).
#[derive(Default)]
struct Ctx {
    dirs: Mutex<HashMap<String, Option<DirInfo>>>,
    refs: Mutex<HashMap<String, HashMap<String, String>>>,
}

#[derive(Clone)]
struct DirInfo {
    top: String,
    main_repo: String,
    head: Option<String>,
    dirty: u32,
}

impl Ctx {
    fn dir(&self, dir: &str) -> Option<DirInfo> {
        if let Some(hit) = self.dirs.lock().unwrap().get(dir) {
            return hit.clone();
        }
        let info = (|| {
            let out = git(dir, &["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"])?;
            let mut l = out.lines();
            let (top, common, head) = (l.next()?.to_string(), l.next()?, l.next().unwrap_or("HEAD"));
            let main_repo = Path::new(common).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or(top.clone());
            Some(DirInfo {
                top,
                main_repo,
                head: (head != "HEAD").then(|| head.to_string()),
                dirty: git(dir, &["status", "--porcelain"]).map(|s| s.lines().count() as u32).unwrap_or(0),
            })
        })();
        self.dirs.lock().unwrap().insert(dir.to_string(), info.clone());
        info
    }

    /// Branches locais do repositório e o commit da ponta de cada uma.
    fn refs(&self, repo: &str, dir: &str) -> HashMap<String, String> {
        if let Some(hit) = self.refs.lock().unwrap().get(repo) {
            return hit.clone();
        }
        let map: HashMap<String, String> = git(dir, &["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"])
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.split_once('\t').map(|(a, b)| (a.to_string(), b.to_string())))
            .collect();
        self.refs.lock().unwrap().insert(repo.to_string(), map.clone());
        map
    }
}

fn git_info(seed: &Seed, ctx: &Ctx) -> Option<GitInfo> {
    let first = seed.dirs.first()?;
    let dir = seed.dirs.iter().find(|d| !d.is_empty() && Path::new(d).is_dir())?;
    let d = ctx.dir(dir)?;
    let refs = ctx.refs(&d.main_repo, dir);

    let mut g = GitInfo {
        project: Path::new(&d.main_repo).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        repo_root: d.main_repo.clone(),
        worktree: !same_path(&d.top, &d.main_repo),
        worktree_missing: !same_path(dir, first) && !Path::new(first).is_dir(),
        ..Default::default()
    };

    // O Codex grava a branch do início do chat; se ela não existe mais (ex.: master renomeada), vale a atual.
    let hinted = seed.branch.clone().filter(|b| seed.run.agent != "codex" || refs.contains_key(b));
    g.branch = match hinted.or(d.head.clone()) {
        Some(b) => b,
        None => return Some(GitInfo { branch: "(detached)".into(), ..g }),
    };
    g.base = seed
        .base
        .clone()
        .filter(|b| refs.contains_key(b))
        .or_else(|| ["main", "master", "develop"].iter().find(|b| refs.contains_key(**b)).map(|b| b.to_string()))
        .unwrap_or_else(|| g.branch.clone());
    g.branch_exists = refs.contains_key(&g.branch);
    g.on_base = g.branch == g.base;
    if d.head.as_deref() == Some(g.branch.as_str()) {
        g.dirty = d.dirty;
    }

    // Cache: commits e estatísticas só mudam quando as pontas da branch/base ou a janela da sessão mudam.
    let tip = |b: &str| refs.get(b).cloned().unwrap_or_default();
    let key = format!(
        "{dir}|{}|{}|{}|{}|{}|{}|{}",
        g.branch, g.base, tip(&g.branch), tip(&g.base), seed.run.created_at, seed.run.updated_at,
        seed.run.prs.iter().map(|p| p.state.as_str()).collect::<String>()
    );
    if let Some(hit) = CACHE.lock().unwrap().get(&key) {
        return Some(GitInfo { dirty: g.dirty, worktree_missing: g.worktree_missing, ..hit.clone() });
    }
    let g = expensive(dir, seed, g);
    CACHE.lock().unwrap().insert(key, g.clone());
    Some(g)
}

static CACHE: std::sync::LazyLock<Mutex<HashMap<String, GitInfo>>> = std::sync::LazyLock::new(Default::default);

fn expensive(dir: &str, seed: &Seed, mut g: GitInfo) -> GitInfo {
    let pr_merged = seed.run.prs.iter().any(|p| p.state.eq_ignore_ascii_case("MERGED"));

    if g.on_base {
        // Trabalho direto na branch base: commits feitos durante a janela da sessão.
        g.merged = true;
        let (from, to) = (seed.run.created_at / 1000 - 120, seed.run.updated_at / 1000 + 300);
        // Lista leve primeiro; o --numstat (caro em repositórios grandes) só roda nos commits da janela.
        let log = git(dir, &["log", &g.base, "-n", "300", "--format=%H%x09%ct%x09%s"]).unwrap_or_default();
        let mut shas = vec![];
        for line in log.lines() {
            let mut p = line.splitn(3, '\t');
            let (Some(sha), Some(ct), subject) = (p.next(), p.next(), p.next().unwrap_or("")) else { continue };
            let ct: i64 = ct.parse().unwrap_or(0);
            if ct < from || ct > to {
                continue;
            }
            g.commit_count += 1;
            if g.commits.len() < MAX_COMMITS {
                g.commits.push(subject.to_string());
            }
            if shas.len() < 40 {
                shas.push(sha.to_string());
            }
        }
        if !shas.is_empty() {
            let mut args = vec!["show", "--numstat", "--format="];
            args.extend(shas.iter().map(String::as_str));
            let (files, ins, del) = numstat(&git(dir, &args).unwrap_or_default());
            (g.files, g.insertions, g.deletions) = (files.len() as u32, ins, del);
        }
    } else if g.branch_exists {
        let count = |range: String| git(dir, &["rev-list", "--count", &range]).and_then(|s| s.parse().ok()).unwrap_or(0);
        g.ahead = count(format!("{}..{}", g.base, g.branch));
        g.behind = count(format!("{}..{}", g.branch, g.base));

        let (log_range, diff_args): (Option<String>, Vec<String>) = if g.ahead > 0 {
            (Some(format!("{}..{}", g.base, g.branch)), vec![format!("{}...{}", g.base, g.branch)])
        } else {
            // Sem commits à frente: ou já foi mesclada, ou nunca recebeu commits.
            // O reflog da branch diz se houve commits desde a criação.
            let reflog = git(dir, &["reflog", "show", "--format=%H", &format!("refs/heads/{}", g.branch)]).unwrap_or_default();
            let shas: Vec<&str> = reflog.lines().collect();
            match (shas.len() > 1, shas.last()) {
                (true, Some(oldest)) if *oldest != shas[0] => {
                    g.merged = true;
                    (Some(format!("{oldest}..{}", g.branch)), vec![oldest.to_string(), g.branch.clone()])
                }
                _ => (None, vec![]),
            }
        };

        if let Some(range) = log_range {
            g.commit_count = count(range.clone());
            g.commits = git(dir, &["log", &range, "-n", &MAX_COMMITS.to_string(), "--format=%s"])
                .map(|s| s.lines().map(String::from).collect())
                .unwrap_or_default();
        }
        if !diff_args.is_empty() {
            let mut args = vec!["diff", "--numstat"];
            args.extend(diff_args.iter().map(String::as_str));
            let (files, ins, del) = numstat(&git(dir, &args).unwrap_or_default());
            (g.files, g.insertions, g.deletions) = (files.len() as u32, ins, del);

            // Squash merge: o conteúdo da branch já está na base, mesmo sem os commits.
            if g.ahead > 0 && !files.is_empty() && files.len() <= 200 {
                let mut q = vec!["diff", "--quiet", g.base.as_str(), g.branch.as_str(), "--"];
                q.extend(files.iter().map(String::as_str));
                g.merged = git_ok(dir, &q);
            }
        }
    }
    g.merged |= pr_merged;
    g
}

fn scan(days: i64, archived: bool) -> Vec<Run> {
    let since = now_ms() - days.max(1) * 86_400_000;
    let mut seeds = claude_seeds(since, archived);
    seeds.extend(codex_seeds(since, archived));

    let ctx = Ctx::default();
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<GitInfo>>> = Mutex::new((0..seeds.len()).map(|_| None).collect());
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(seed) = seeds.get(i) else { break };
                let info = git_info(seed, &ctx);
                results.lock().unwrap()[i] = info;
            });
        }
    });

    let infos = results.into_inner().unwrap();
    let mut runs: Vec<Run> = seeds
        .into_iter()
        .zip(infos)
        .map(|(mut s, g)| {
            s.run.git = g;
            s.run
        })
        .collect();
    runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    runs
}

// ---------- Comandos ----------

#[tauri::command]
async fn list_runs(days: i64, archived: bool) -> Result<Vec<Run>, String> {
    tauri::async_runtime::spawn_blocking(move || scan(days, archived)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn open_run(url: String) -> Result<(), String> {
    let allowed = url.starts_with("claude://code/continue?session=local_") || url.starts_with("codex://threads/");
    if !allowed || url.chars().any(|c| c.is_whitespace() || c == '"' || c == '&') {
        return Err("Link não permitido".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err("A pasta não existe mais".into());
    }
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Link não permitido".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Varre as pendências dos repositórios dos chats dos últimos 90 dias e liga cada uma ao chat mais recente
/// que trabalhou naquela pasta (ou naquela branch).
fn pending_now() -> Vec<pending::Pending> {
    let since = now_ms() - 90 * 86_400_000;
    let mut seeds = claude_seeds(since, true);
    seeds.extend(codex_seeds(since, true));
    let dirs: Vec<String> = seeds.iter().flat_map(|s| s.dirs.clone()).collect();
    let mut items = pending::scan(&Ctx::default(), &dirs, now_ms());
    seeds.sort_by(|a, b| b.run.updated_at.cmp(&a.run.updated_at));
    for p in &mut items {
        let at_repo = same_path(&p.path, &p.repo_root);
        let hit = seeds.iter().find(|s| {
            let same_dir = s.dirs.iter().any(|d| same_path(d, &p.path));
            let same_branch = s.branch.as_deref() == Some(p.branch.as_str());
            if at_repo { same_dir && (same_branch || s.branch.is_none()) || same_branch && s.dirs.iter().any(|d| same_path(d, &p.repo_root)) } else { same_dir }
        });
        if let Some(s) = hit {
            p.chat_title = Some(s.run.title.clone());
            p.chat_url = Some(s.run.open_url.clone());
            p.chat_agent = Some(s.run.agent);
        }
    }
    items
}

#[tauri::command]
async fn list_pending() -> Result<Vec<pending::Pending>, String> {
    tauri::async_runtime::spawn_blocking(pending_now).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let a = app.autolaunch();
    if on { a.enable() } else { a.disable() }.map_err(|e| e.to_string())
}

// ---------- Atualização pelo GitHub Releases (renanrmsantos14/painel-agentes) ----------
// Só baixa quando a pessoa clica em "Atualizar agora"; o instalador roda em silêncio e reabre o app.

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() }))
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;
    let Some(update) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
        return Err("Já está na versão mais recente".into());
    };
    let progress = app.clone();
    let mut received: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let pct = total.filter(|t| *t > 0).map(|t| received * 100 / t).unwrap_or(0);
                let _ = progress.emit("update-progress", pct);
            },
            || {},
        )
        .await
        .map_err(|e| format!("Falha ao baixar ou instalar a atualização: {e}"))?;
    app.restart();
}

const DAY_MS: i64 = 86_400_000;
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(15 * 60);

fn kind_text(p: &pending::Pending) -> String {
    match p.kind {
        "dirty" => format!("{} arquivo(s) não commitado(s)", p.count),
        "unmerged" => format!("{} commit(s) fora da {}", p.count, p.base),
        "unpushed" => format!("{} commit(s) sem push", p.count),
        _ => String::new(),
    }
}

/// Verifica as pendências periodicamente e avisa pelo Windows o que está parado há mais de 1 dia.
/// Cada pendência é avisada no máximo uma vez por dia (registro em avisos.json na pasta do app).
fn watcher(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    use tauri_plugin_notification::NotificationExt;
    std::thread::spawn(move || {
        let file = app.path().app_data_dir().ok().map(|d| d.join("avisos.json"));
        std::thread::sleep(std::time::Duration::from_secs(90));
        loop {
            let items = pending_now();
            let now = now_ms();
            let mut sent: HashMap<String, i64> = file
                .as_ref()
                .and_then(|f| std::fs::read_to_string(f).ok())
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();
            let due: Vec<&pending::Pending> = items
                .iter()
                .filter(|p| p.kind != "cleanup" && now - p.last_activity > DAY_MS && now - sent.get(&p.key).copied().unwrap_or(0) > DAY_MS)
                .collect();
            if !due.is_empty() {
                let mut body: Vec<String> = due.iter().take(3).map(|p| format!("{} · {} — {}", p.project, p.branch, kind_text(p))).collect();
                if due.len() > 3 {
                    body.push(format!("e mais {}", due.len() - 3));
                }
                let title = if due.len() == 1 { "1 trabalho esquecido no Git".to_string() } else { format!("{} trabalhos esquecidos no Git", due.len()) };
                let _ = app.notification().builder().title(title).body(body.join("\n")).show();
                for p in &due {
                    sent.insert(p.key.clone(), now);
                }
                sent.retain(|_, t| now - *t < 7 * DAY_MS);
                if let Some(f) = &file {
                    if let Some(dir) = f.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(f, serde_json::to_string(&sent).unwrap_or_default());
                }
            }
            let _ = app.emit("pending-updated", ());
            std::thread::sleep(WATCH_EVERY);
        }
    });
}

fn show_main(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Diagnóstico: `painel-agentes.exe --dump [dias]` grava chats e pendências em JSON, sem abrir janela.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--dump") {
        let days = args.get(2).and_then(|d| d.parse().ok()).unwrap_or(7);
        let _ = std::fs::write("painel-dump.json", serde_json::to_string_pretty(&scan(days, false)).unwrap_or_default());
        let _ = std::fs::write("painel-pendencias.json", serde_json::to_string_pretty(&pending_now()).unwrap_or_default());
        return;
    }
    let minimized = args.iter().any(|a| a == "--minimized");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .invoke_handler(tauri::generate_handler![list_runs, list_pending, open_run, open_folder, open_link, get_autostart, set_autostart, check_update, install_update])
        .setup(move |app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
            use tauri::Manager;
            let show = MenuItem::with_id(app, "show", "Abrir painel", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("ícone do app"))
                .tooltip("Painel Agentes")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            if minimized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            watcher(app.handle().clone());
            Ok(())
        })
        // Fechar a janela só esconde: o painel segue na bandeja para avisar das pendências.
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Painel Agentes");
}
