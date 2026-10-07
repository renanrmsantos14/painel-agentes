//! Pendências: trabalho que ainda não está mesclado na branch principal E enviado ao GitHub.
//! Olha os worktrees e branches de cada repositório, não só os chats, para nada ficar esquecido.

use crate::cache::{self, Cache};
use crate::{git, git_ok, same_path};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::UNIX_EPOCH;

/// `unmerged` só depende das pontas da base e da branch: com o mesmo par de commits, a resposta é a mesma.
static UNMERGED: LazyLock<Mutex<HashMap<String, (u32, Vec<String>)>>> = LazyLock::new(Default::default);
/// Pasta -> repositório principal (`None` se a pasta não é Git). Quase não muda.
static REPO_OF: Cache<Option<String>> = Cache::new();
/// Worktrees por repositório; o vigia invalida quando `.git` muda (add/remove de worktree).
pub(crate) static WORKTREES: Cache<Arc<Vec<Wt>>> = Cache::new();

/// Branches sem worktree só contam se tiveram commit nos últimos dias (evita branches antigas abandonadas).
const BRANCH_MAX_AGE_DAYS: i64 = 30;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub key: String,
    /// dirty | unmerged | unpushed | cleanup
    pub kind: String,
    pub project: String,
    pub repo_root: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    pub count: u32,
    pub last_activity: i64,
    pub commits: Vec<String>,
    pub worktree: bool,
    /// Chat mais recente ligado a esta pendência (pela pasta ou branch).
    pub chat_title: Option<String>,
    pub chat_url: Option<String>,
    pub chat_agent: Option<String>,
}

pub(crate) struct Ref {
    pub(crate) tip: String,
    pub(crate) time: i64,
    pub(crate) upstream: String,
    pub(crate) track: String,
}

pub(crate) struct Refs {
    pub(crate) heads: HashMap<String, Ref>,
    /// Pontas das branches remotas (ex.: `origin/main`).
    pub(crate) remotes: HashMap<String, String>,
    /// Branch padrão do GitHub (`origin/HEAD`), sem o prefixo `origin/`.
    pub(crate) origin_head: Option<String>,
}

/// Refs por repositório, compartilhadas entre chats e pendências; o vigia invalida quando `.git` muda.
pub(crate) static REFS: Cache<Arc<Refs>> = Cache::new();

pub(crate) fn refs_cached(repo: &str) -> Arc<Refs> {
    if let Some(r) = REFS.get(repo) {
        return r;
    }
    let r = Arc::new(refs(repo));
    REFS.put(repo, r.clone());
    r
}

/// Branches locais e remotas num único `for-each-ref` (antes eram também `symbolic-ref` e `git remote`).
fn refs(dir: &str) -> Refs {
    let fmt = "--format=%(refname)%09%(objectname)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)%09%(symref)";
    let out = git(dir, &["for-each-ref", fmt, "refs/heads", "refs/remotes"]).unwrap_or_default();
    let mut r = Refs { heads: HashMap::new(), remotes: HashMap::new(), origin_head: None };
    for l in out.lines() {
        let mut p = l.split('\t');
        let (Some(name), Some(tip)) = (p.next(), p.next()) else { continue };
        let time = p.next().and_then(|t| t.parse::<i64>().ok()).unwrap_or(0) * 1000;
        let (upstream, track, symref) = (p.next().unwrap_or(""), p.next().unwrap_or(""), p.next().unwrap_or(""));
        if let Some(b) = name.strip_prefix("refs/heads/") {
            r.heads.insert(b.to_string(), Ref { tip: tip.to_string(), time, upstream: upstream.to_string(), track: track.to_string() });
        } else if name == "refs/remotes/origin/HEAD" {
            r.origin_head = symref.strip_prefix("refs/remotes/origin/").map(String::from);
        } else if let Some(b) = name.strip_prefix("refs/remotes/") {
            r.remotes.insert(b.to_string(), tip.to_string());
        }
    }
    r
}

fn track_ahead(track: &str) -> u32 {
    track
        .split(|c| c == '[' || c == ']' || c == ',')
        .find_map(|s| s.trim().strip_prefix("ahead ").and_then(|n| n.parse().ok()))
        .unwrap_or(0)
}

fn base_of(r: &Refs) -> Option<String> {
    let refs = &r.heads;
    r.origin_head
        .clone()
        .filter(|b| refs.contains_key(b))
        .or_else(|| ["main", "master", "develop"].iter().find(|b| refs.contains_key(**b)).map(|b| b.to_string()))
}

/// Data do último commit da branch, já lida pelo `for-each-ref` (sem outro processo git).
fn tip_time(refs: &HashMap<String, Ref>, branch: &str) -> i64 {
    refs.get(branch).map(|r| r.time).unwrap_or(0)
}

/// `unmerged` com cache pelas pontas dos commits; sem as pontas, calcula direto.
fn unmerged_cached(dir: &str, refs: &HashMap<String, Ref>, base: &str, branch: &str) -> (u32, Vec<String>) {
    let (Some(b), Some(t)) = (refs.get(base), refs.get(branch)) else { return unmerged(dir, base, branch) };
    let key = format!("{}|{}", b.tip, t.tip);
    if let Some(hit) = UNMERGED.lock().unwrap().get(&key) {
        return hit.clone();
    }
    let res = unmerged(dir, base, branch);
    let mut cache = UNMERGED.lock().unwrap();
    if cache.len() > 2000 {
        cache.clear();
    }
    cache.insert(key, res.clone());
    res
}

/// Commits da branch que ainda não estão na base. Zero se já foi mesclada, inclusive por squash.
fn unmerged(dir: &str, base: &str, branch: &str) -> (u32, Vec<String>) {
    let range = format!("{base}..{branch}");
    let ahead: u32 = git(dir, &["rev-list", "--count", &range]).and_then(|s| s.parse().ok()).unwrap_or(0);
    if ahead == 0 {
        return (0, vec![]);
    }
    let files: Vec<String> = git(dir, &["diff", "--name-only", &format!("{base}...{branch}")])
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect();
    if !files.is_empty() && files.len() <= 200 {
        let mut q = vec!["diff", "--quiet", base, branch, "--"];
        q.extend(files.iter().map(String::as_str));
        if git_ok(dir, &q) {
            return (0, vec![]);
        }
    }
    let commits = git(dir, &["log", &range, "-n", "5", "--format=%s"]).map(|s| s.lines().map(String::from).collect()).unwrap_or_default();
    (ahead, commits)
}

/// Arquivos alterados e a data da alteração mais recente entre eles.
fn dirty(dir: &str) -> (u32, i64) {
    let out = cache::status(dir);
    let mut newest = 0i64;
    let mut n = 0;
    for line in out.lines() {
        n += 1;
        let path = line.get(3..).unwrap_or("").rsplit(" -> ").next().unwrap_or("").trim_matches('"');
        if let Ok(m) = std::fs::metadata(Path::new(dir).join(path)).and_then(|m| m.modified()) {
            newest = newest.max(m.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0));
        }
    }
    if n > 0 && newest == 0 {
        newest = git(dir, &["rev-parse", "--git-path", "index"])
            .map(|p| Path::new(dir).join(p))
            .and_then(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
    }
    (n, newest)
}

pub(crate) struct Wt {
    path: String,
    branch: Option<String>,
    locked: bool,
}

fn worktrees(repo: &str) -> Arc<Vec<Wt>> {
    if let Some(w) = WORKTREES.get(repo) {
        return w;
    }
    let w = Arc::new(worktrees_fresh(repo));
    WORKTREES.put(repo, w.clone());
    w
}

fn worktrees_fresh(dir: &str) -> Vec<Wt> {
    let out = git(dir, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let mut list = vec![];
    for block in out.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        let mut prunable = false;
        let mut locked = false;
        for l in block.lines() {
            if let Some(p) = l.strip_prefix("worktree ") {
                path = Some(p.replace('/', "\\"));
            } else if let Some(b) = l.strip_prefix("branch refs/heads/") {
                branch = Some(b.to_string());
            } else if l.starts_with("prunable") || l == "bare" {
                prunable = true;
            } else if l.starts_with("locked") {
                locked = true;
            }
        }
        if let (Some(path), false) = (path, prunable) {
            if Path::new(&path).is_dir() {
                list.push(Wt { path, branch, locked });
            }
        }
    }
    list
}

/// Commits da base ainda não enviados ao GitHub, com cache pelas pontas local e remota.
fn unpushed(repo: &str, base: &str, r: &Ref, remote_tip: Option<&String>) -> (u32, Vec<String>) {
    let key = format!("push|{}|{}|{}", r.tip, remote_tip.map(String::as_str).unwrap_or(""), r.track);
    if let Some(hit) = UNMERGED.lock().unwrap().get(&key) {
        return hit.clone();
    }
    let range = format!("origin/{base}..{base}");
    let ahead = if !r.upstream.is_empty() {
        track_ahead(&r.track)
    } else if remote_tip.is_some() {
        git(repo, &["rev-list", "--count", &range]).and_then(|s| s.parse().ok()).unwrap_or(0)
    } else {
        0
    };
    let commits = if ahead > 0 {
        git(repo, &["log", &range, "-n", "5", "--format=%s"]).map(|s| s.lines().map(String::from).collect()).unwrap_or_default()
    } else {
        vec![]
    };
    UNMERGED.lock().unwrap().insert(key, (ahead, commits.clone()));
    (ahead, commits)
}

struct RepoHead {
    repo: String,
    project: String,
    base: String,
    refs: Arc<Refs>,
    worktrees: Arc<Vec<Wt>>,
}

#[allow(clippy::too_many_arguments)]
fn item(kind: &str, project: &str, repo: &str, base: &str, path: &str, branch: &str, count: u32, last: i64, commits: Vec<String>, worktree: bool) -> Pending {
    Pending {
        key: format!("{kind}|{}|{branch}", path.to_lowercase()),
        kind: kind.to_string(),
        project: project.to_string(),
        repo_root: repo.to_string(),
        path: path.to_string(),
        branch: branch.to_string(),
        base: base.to_string(),
        count,
        last_activity: last,
        commits,
        worktree,
        chat_title: None,
        chat_url: None,
        chat_agent: None,
    }
}

/// Fase 1 (por repositório): refs, base, lista de worktrees, "sem push" e branches sem worktree.
fn scan_repo_head(repo: &str, now: i64) -> Option<(RepoHead, Vec<Pending>)> {
    let all = refs_cached(repo);
    let base = base_of(&all)?;
    let project = Path::new(repo).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let worktrees = worktrees(repo);
    let with_worktree: HashSet<&str> = worktrees.iter().filter_map(|w| w.branch.as_deref()).collect();
    let mut out = vec![];

    // Base mesclada mas não enviada ao GitHub.
    if !all.remotes.is_empty() {
        if let Some(r) = all.heads.get(&base) {
            let (ahead, commits) = unpushed(repo, &base, r, all.remotes.get(&format!("origin/{base}")));
            if ahead > 0 {
                out.push(item("unpushed", &project, repo, &base, repo, &base, ahead, tip_time(&all.heads, &base), commits, false));
            }
        }
    }

    // Branches sem worktree com commits recentes que nunca chegaram à base.
    for (b, r) in &all.heads {
        if *b == base || with_worktree.contains(b.as_str()) || r.tip.is_empty() || now - r.time > BRANCH_MAX_AGE_DAYS * 86_400_000 {
            continue;
        }
        let (ahead, commits) = unmerged_cached(repo, &all.heads, &base, b);
        if ahead > 0 {
            out.push(item("unmerged", &project, repo, &base, repo, b, ahead, r.time, commits, false));
        }
    }
    Some((RepoHead { repo: repo.to_string(), project, base, refs: all, worktrees }, out))
}

/// Fase 2 (por worktree): arquivos sujos e commits fora da base.
fn scan_worktree(h: &RepoHead, wt: &Wt) -> Vec<Pending> {
    let is_main = same_path(&wt.path, &h.repo);
    let (n, newest) = dirty(&wt.path);
    let branch = wt.branch.clone().unwrap_or_else(|| "(detached)".into());
    let mut out = vec![];
    let item = |kind: &str, branch: &str, count, last, commits, worktree| item(kind, &h.project, &h.repo, &h.base, &wt.path, branch, count, last, commits, worktree);
    if n > 0 {
        out.push(item("dirty", &branch, n, newest, vec![], !is_main));
    }
    let Some(b) = &wt.branch else { return out };
    if *b == h.base {
        return out;
    }
    let (ahead, commits) = unmerged_cached(&wt.path, &h.refs.heads, &h.base, b);
    if ahead > 0 {
        out.push(item("unmerged", b, ahead, tip_time(&h.refs.heads, b), commits, !is_main));
    } else if n == 0 && !is_main {
        out.push(item("cleanup", b, 0, tip_time(&h.refs.heads, b), vec![], true));
    }
    out
}

/// Repositórios conhecidos: pastas dos chats + subpastas com Git em Desktop\vscode e Desktop\Projetos.
pub fn repos(chat_dirs: &[String]) -> Vec<String> {
    let mut dirs: Vec<String> = chat_dirs.to_vec();
    // Pastas das configurações; por padrão Desktop\vscode e Desktop\Projetos.
    for root in crate::settings::get().roots {
        if let Ok(entries) = std::fs::read_dir(PathBuf::from(root)) {
            for e in entries.flatten() {
                if e.path().join(".git").exists() {
                    dirs.push(e.path().to_string_lossy().to_string());
                }
            }
        }
    }
    // Só descobre o repositório de cada pasta (um rev-parse leve, sem status), sem repetir pastas.
    let mut seen_dir = HashSet::new();
    let mut seen = HashSet::new();
    let mut out = vec![];
    for d in dirs {
        if d.is_empty() || !seen_dir.insert(d.to_lowercase()) || !Path::new(&d).is_dir() {
            continue;
        }
        let repo = match REPO_OF.get(&d) {
            Some(known) => known,
            None => {
                let found = git(&d, &["rev-parse", "--path-format=absolute", "--git-common-dir"])
                    .and_then(|common| Path::new(&common).parent().map(|p| p.to_string_lossy().replace('/', "\\")));
                REPO_OF.put(&d, found.clone());
                found
            }
        };
        let Some(repo) = repo else { continue };
        if seen.insert(repo.to_lowercase()) && Path::new(&repo).is_dir() {
            out.push(repo);
        }
    }
    out
}

/// Roda `f` sobre `items` em até `workers` threads e junta os resultados.
fn parallel<T: Sync, R: Send>(items: &[T], workers: usize, f: impl Fn(&T) -> Vec<R> + Sync) -> Vec<R> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let out = Mutex::new(vec![]);
    std::thread::scope(|s| {
        for _ in 0..workers.min(items.len().max(1)) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(it) = items.get(i) else { break };
                let r = f(it);
                out.lock().unwrap().extend(r);
            });
        }
    });
    out.into_inner().unwrap()
}

/// Pendências de todos os repositórios conhecidos e as raízes `(worktree, repositório)` para o vigia.
pub fn scan(chat_dirs: &[String], now: i64) -> (Vec<Pending>, Vec<(String, String)>) {
    let repos = repos(chat_dirs);
    let heads: Vec<(RepoHead, Vec<Pending>)> = parallel(&repos, 8, |r| scan_repo_head(r, now).into_iter().collect());
    let mut list: Vec<Pending> = vec![];
    let mut tasks: Vec<(&RepoHead, &Wt)> = vec![];
    let mut roots = vec![];
    for (h, items) in &heads {
        list.extend(items.iter().cloned());
        roots.push((h.repo.clone(), h.repo.clone()));
        for wt in h.worktrees.iter() {
            tasks.push((h, wt));
            roots.push((wt.path.clone(), h.repo.clone()));
        }
    }
    list.extend(parallel(&tasks, 8, |(h, wt)| scan_worktree(h, wt)));
    list.sort_by(|a, b| a.last_activity.cmp(&b.last_activity));
    (list, roots)
}

/// Pasta (dentro do .git do repositório) para onde vão os worktrees removidos até serem apagados em segundo plano.
const TRASH: &str = "painel-lixo";

/// Remove um worktree só quando nada se perde: pasta limpa e branch já mesclada na base. Mantém a branch.
/// Apagar node_modules e target arquivo por arquivo (`git worktree remove`) leva minutos; por isso a pasta é
/// movida para o lixo do repositório (instantâneo, mesmo volume), o registro do worktree é desfeito e a
/// exclusão física roda em segundo plano.
pub fn remove_worktree(path: &str) -> Result<(), String> {
    if !Path::new(path).is_dir() {
        return Err("A pasta do worktree não existe mais".into());
    }
    // Uma chamada só: pasta comum do repositório e pasta administrativa do worktree (.git/worktrees/<nome>).
    let dirs = git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"]).ok_or("A pasta não é um repositório Git")?;
    let mut dirs = dirs.lines();
    let (Some(common), Some(admin)) = (dirs.next(), dirs.next()) else { return Err("A pasta não é um repositório Git".into()) };
    let repo = Path::new(common).parent().map(|p| p.to_string_lossy().replace('/', "\\")).ok_or("Repositório não encontrado")?;
    if same_path(path, &repo) {
        return Err("Esta é a pasta principal do repositório, não um worktree".into());
    }
    let wt = worktrees_fresh(&repo).into_iter().find(|w| same_path(&w.path, path)).ok_or("A pasta não está na lista de worktrees do repositório")?;
    if wt.locked {
        return Err("O worktree está travado (git worktree lock)".into());
    }
    let branch = wt.branch.ok_or("Worktree sem branch (detached): remova manualmente")?;
    // Decisão de apagar pasta: lê status e refs frescos, sem depender do cache.
    cache::STATUS.invalidate(path);
    if dirty(path).0 > 0 {
        return Err("O worktree tem arquivos não commitados".into());
    }
    let fresh = Arc::new(refs(&repo));
    REFS.put(&repo, fresh.clone());
    let base = base_of(&fresh).ok_or("Branch base não encontrada")?;
    if branch == base || unmerged(path, &base, &branch).0 > 0 {
        return Err(format!("A branch {branch} ainda tem commits fora da {base}"));
    }

    // A pasta administrativa só é apagada se estiver mesmo em .git/worktrees.
    let admin = PathBuf::from(admin);
    let common = PathBuf::from(common);
    if !admin.parent().is_some_and(|p| same_path(&p.to_string_lossy(), &common.join("worktrees").to_string_lossy())) {
        return Err("Pasta administrativa do worktree fora do lugar esperado".into());
    }
    // Os caches do repositório ficam velhos depois da remoção.
    let forget = || {
        REFS.invalidate(&repo);
        WORKTREES.invalidate(&repo);
        cache::STATUS.invalidate(path);
    };

    let trash = common.join(TRASH);
    let _ = std::fs::create_dir_all(&trash);
    let name = Path::new(path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "wt".into());
    let stamp = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dest = trash.join(format!("{name}-{stamp}"));
    if let Err(e) = std::fs::rename(path, &dest) {
        // Outro volume (ERROR_NOT_SAME_DEVICE): sem atalho, o Git apaga do jeito lento.
        if e.raw_os_error() == Some(17) {
            let out = crate::git_cmd(&repo, &["worktree", "remove", path]).output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(format!("O Git recusou remover: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            forget();
            return Ok(());
        }
        return Err(format!("A pasta está em uso por outro programa (terminal, editor ou servidor): {e}"));
    }
    if std::fs::remove_dir_all(&admin).is_err() {
        let _ = crate::git_cmd(&repo, &["worktree", "prune"]).output();
    }
    empty_trash(trash);
    forget();
    Ok(())
}

/// Apaga em segundo plano o conteúdo do lixo do repositório (inclui sobras de execuções anteriores).
/// A pasta do lixo em si fica, para não atrapalhar outra remoção movendo para ela ao mesmo tempo.
/// `rd /s /q` é bem mais rápido que apagar arquivo por arquivo e não segue junctions (pnpm).
fn empty_trash(trash: PathBuf) {
    std::thread::spawn(move || {
        for e in std::fs::read_dir(&trash).into_iter().flatten().flatten() {
            let p = e.path();
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("cmd").arg("/c").arg("rd").arg("/s").arg("/q").arg(&p).creation_flags(0x0800_0000).output();
            }
            let _ = std::fs::remove_dir_all(&p);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::remove_worktree;
    use std::process::Command;

    fn sh(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?} falhou");
    }

    #[test]
    fn remove_so_worktree_limpa_e_mesclada() {
        let root = std::env::temp_dir().join(format!("painel-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
        let wt = root.join("wt");
        let wt_s = wt.to_string_lossy().to_string();
        sh(&repo, &["worktree", "add", "-q", "-b", "feat", &wt_s]);

        // Com arquivo não commitado: recusa.
        std::fs::write(wt.join("a.txt"), "x").unwrap();
        assert!(remove_worktree(&wt_s).is_err());
        // Com commit fora da main: recusa.
        sh(&wt, &["add", "a.txt"]);
        sh(&wt, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a"]);
        assert!(remove_worktree(&wt_s).unwrap_err().contains("fora da main"));
        // Pasta principal: recusa.
        assert!(remove_worktree(&repo.to_string_lossy()).is_err());
        // Mesclada e limpa: remove a pasta e mantém a branch.
        sh(&repo, &["merge", "-q", "--ff-only", "feat"]);
        remove_worktree(&wt_s).unwrap();
        assert!(!wt.exists());
        sh(&repo, &["rev-parse", "--verify", "-q", "feat"]);
        let list = Command::new("git").arg("-C").arg(&repo).args(["worktree", "list", "--porcelain"]).output().unwrap();
        assert!(!String::from_utf8_lossy(&list.stdout).contains("feat"), "registro do worktree ficou para trás");
        let _ = std::fs::remove_dir_all(&root);
    }
}
