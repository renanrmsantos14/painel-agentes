//! Pendências: trabalho que ainda não está mesclado na branch principal E enviado ao GitHub.
//! Olha os worktrees e branches de cada repositório, não só os chats, para nada ficar esquecido.

use crate::{git, git_ok, same_path, Ctx};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Branches sem worktree só contam se tiveram commit nos últimos dias (evita branches antigas abandonadas).
const BRANCH_MAX_AGE_DAYS: i64 = 30;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub key: String,
    /// dirty | unmerged | unpushed | cleanup
    pub kind: &'static str,
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
    pub chat_agent: Option<&'static str>,
}

struct Ref {
    tip: String,
    time: i64,
    upstream: String,
    track: String,
}

fn refs(dir: &str) -> HashMap<String, Ref> {
    git(dir, &["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)", "refs/heads"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut p = l.split('\t');
            Some((
                p.next()?.to_string(),
                Ref { tip: p.next()?.to_string(), time: p.next()?.parse::<i64>().unwrap_or(0) * 1000, upstream: p.next().unwrap_or("").to_string(), track: p.next().unwrap_or("").to_string() },
            ))
        })
        .collect()
}

fn track_ahead(track: &str) -> u32 {
    track
        .split(|c| c == '[' || c == ']' || c == ',')
        .find_map(|s| s.trim().strip_prefix("ahead ").and_then(|n| n.parse().ok()))
        .unwrap_or(0)
}

fn base_of(dir: &str, refs: &HashMap<String, Ref>) -> Option<String> {
    let remote_head = git(dir, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
        .and_then(|s| s.strip_prefix("origin/").map(String::from));
    remote_head
        .filter(|b| refs.contains_key(b))
        .or_else(|| ["main", "master", "develop"].iter().find(|b| refs.contains_key(**b)).map(|b| b.to_string()))
}

fn commit_time(dir: &str, rev: &str) -> i64 {
    git(dir, &["log", "-1", "--format=%ct", rev]).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) * 1000
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
    let out = git(dir, &["status", "--porcelain"]).unwrap_or_default();
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

struct Wt {
    path: String,
    branch: Option<String>,
}

fn worktrees(dir: &str) -> Vec<Wt> {
    let out = git(dir, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let mut list = vec![];
    for block in out.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        let mut prunable = false;
        for l in block.lines() {
            if let Some(p) = l.strip_prefix("worktree ") {
                path = Some(p.replace('/', "\\"));
            } else if let Some(b) = l.strip_prefix("branch refs/heads/") {
                branch = Some(b.to_string());
            } else if l.starts_with("prunable") || l == "bare" {
                prunable = true;
            }
        }
        if let (Some(path), false) = (path, prunable) {
            if Path::new(&path).is_dir() {
                list.push(Wt { path, branch });
            }
        }
    }
    list
}

fn scan_repo(repo: &str, now: i64) -> Vec<Pending> {
    let refs = refs(repo);
    let Some(base) = base_of(repo, &refs) else { return vec![] };
    let project = Path::new(repo).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let has_remote = git(repo, &["remote"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let mut out = vec![];
    let item = |kind: &'static str, path: &str, branch: &str, count: u32, last: i64, commits: Vec<String>, worktree: bool| Pending {
        key: format!("{kind}|{}|{branch}", path.to_lowercase()),
        kind,
        project: project.clone(),
        repo_root: repo.to_string(),
        path: path.to_string(),
        branch: branch.to_string(),
        base: base.clone(),
        count,
        last_activity: last,
        commits,
        worktree,
        chat_title: None,
        chat_url: None,
        chat_agent: None,
    };

    // Base mesclada mas não enviada ao GitHub.
    if has_remote {
        if let Some(r) = refs.get(&base) {
            let ahead = if r.upstream.is_empty() {
                git(repo, &["rev-list", "--count", &format!("origin/{base}..{base}")]).and_then(|s| s.parse().ok()).unwrap_or(0)
            } else {
                track_ahead(&r.track)
            };
            if ahead > 0 {
                let commits = git(repo, &["log", &format!("origin/{base}..{base}"), "-n", "5", "--format=%s"])
                    .map(|s| s.lines().map(String::from).collect())
                    .unwrap_or_default();
                out.push(item("unpushed", repo, &base, ahead, commit_time(repo, &base), commits, false));
            }
        }
    }

    let mut with_worktree = HashSet::new();
    for wt in worktrees(repo) {
        let is_main = same_path(&wt.path, repo);
        let (n, newest) = dirty(&wt.path);
        let branch = wt.branch.clone().unwrap_or_else(|| "(detached)".into());
        if n > 0 {
            out.push(item("dirty", &wt.path, &branch, n, newest, vec![], !is_main));
        }
        let Some(b) = wt.branch else { continue };
        with_worktree.insert(b.clone());
        if b == base {
            continue;
        }
        let (ahead, commits) = unmerged(&wt.path, &base, &b);
        if ahead > 0 {
            out.push(item("unmerged", &wt.path, &b, ahead, commit_time(&wt.path, &b), commits, !is_main));
        } else if n == 0 && !is_main {
            out.push(item("cleanup", &wt.path, &b, 0, commit_time(&wt.path, &b), vec![], true));
        }
    }

    // Branches sem worktree com commits recentes que nunca chegaram à base.
    for (b, r) in &refs {
        if *b == base || with_worktree.contains(b) || r.tip.is_empty() {
            continue;
        }
        let last = r.time;
        if now - last > BRANCH_MAX_AGE_DAYS * 86_400_000 {
            continue;
        }
        let (ahead, commits) = unmerged(repo, &base, b);
        if ahead > 0 {
            out.push(item("unmerged", repo, b, ahead, last, commits, false));
        }
    }
    out
}

/// Repositórios conhecidos: pastas dos chats + subpastas com Git em Desktop\vscode e Desktop\Projetos.
pub fn repos(ctx: &Ctx, chat_dirs: &[String]) -> Vec<String> {
    let mut dirs: Vec<String> = chat_dirs.to_vec();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        for sub in ["vscode", "Projetos"] {
            let root = PathBuf::from(&home).join("Desktop").join(sub);
            if let Ok(entries) = std::fs::read_dir(root) {
                for e in entries.flatten() {
                    if e.path().join(".git").exists() {
                        dirs.push(e.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    // Só descobre o repositório de cada pasta (um rev-parse leve, sem status), sem repetir pastas.
    let _ = ctx;
    let mut seen_dir = HashSet::new();
    let mut seen = HashSet::new();
    let mut out = vec![];
    for d in dirs {
        if d.is_empty() || !seen_dir.insert(d.to_lowercase()) || !Path::new(&d).is_dir() {
            continue;
        }
        let Some(common) = git(&d, &["rev-parse", "--path-format=absolute", "--git-common-dir"]) else { continue };
        let Some(repo) = Path::new(&common).parent().map(|p| p.to_string_lossy().replace('/', "\\")) else { continue };
        if seen.insert(repo.to_lowercase()) {
            out.push(repo);
        }
    }
    out
}

pub fn scan(ctx: &Ctx, chat_dirs: &[String], now: i64) -> Vec<Pending> {
    let repos = repos(ctx, chat_dirs);
    let results = std::sync::Mutex::new(vec![]);
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..6 {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(repo) = repos.get(i) else { break };
                let items = scan_repo(repo, now);
                results.lock().unwrap().extend(items);
            });
        }
    });
    let mut list = results.into_inner().unwrap();
    list.sort_by(|a, b| a.last_activity.cmp(&b.last_activity));
    list
}

/// Remove um worktree só quando nada se perde: pasta limpa e branch já mesclada na base.
/// Usa `git worktree remove` sem `--force` (o Git ainda recusa se achar algo não salvo) e mantém a branch.
pub fn remove_worktree(path: &str) -> Result<(), String> {
    if !Path::new(path).is_dir() {
        return Err("A pasta do worktree não existe mais".into());
    }
    let common = git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok_or("A pasta não é um repositório Git")?;
    let repo = Path::new(&common).parent().map(|p| p.to_string_lossy().replace('/', "\\")).ok_or("Repositório não encontrado")?;
    if same_path(path, &repo) {
        return Err("Esta é a pasta principal do repositório, não um worktree".into());
    }
    let wt = worktrees(&repo).into_iter().find(|w| same_path(&w.path, path)).ok_or("A pasta não está na lista de worktrees do repositório")?;
    let branch = wt.branch.ok_or("Worktree sem branch (detached): remova manualmente")?;
    if dirty(path).0 > 0 {
        return Err("O worktree tem arquivos não commitados".into());
    }
    let base = base_of(&repo, &refs(&repo)).ok_or("Branch base não encontrada")?;
    if branch == base || unmerged(path, &base, &branch).0 > 0 {
        return Err(format!("A branch {branch} ainda tem commits fora da {base}"));
    }
    let out = crate::git_cmd(&repo, &["worktree", "remove", path]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("O Git recusou remover: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
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
        let _ = std::fs::remove_dir_all(&root);
    }
}
