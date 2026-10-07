//! Vigia de arquivos: só roda git onde algo mudou.
//! Mudança em arquivo de trabalho invalida o `status` daquela worktree; mudança em `.git/`
//! invalida as refs do repositório e o `status` de todas as suas worktrees.

use crate::cache::{self, norm};
use notify::{EventKind, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::sync::mpsc;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(1500);
const IGNORED_DIRS: [&str; 4] = ["node_modules", "target", "dist", ".memsearch"];

#[derive(Debug, PartialEq)]
pub enum Change {
    /// Arquivo de trabalho mudou nesta worktree.
    Work(String),
    /// Algo em `.git/` mudou neste repositório (commit, checkout, branch).
    Git(String),
}

/// Decide o que uma mudança em `path` invalida. `roots` = (worktree, repositório principal).
pub fn classify(path: &str, roots: &[(String, String)]) -> Option<Change> {
    let p = norm(path);
    if p.ends_with(".lock") {
        return None;
    }
    let segs: Vec<&str> = p.split('/').collect();
    if segs.iter().any(|s| IGNORED_DIRS.contains(s)) {
        return None;
    }
    if let Some(i) = segs.iter().position(|s| *s == ".git") {
        if matches!(segs.get(i + 1), Some(&"objects") | Some(&"logs")) {
            return None;
        }
        let repo_prefix = segs[..i].join("/");
        return roots.iter().find(|(w, _)| norm(w) == repo_prefix).map(|(_, r)| Change::Git(r.clone()));
    }
    // Worktree mais específica (prefixo mais longo) que contém o caminho.
    roots
        .iter()
        .filter(|(w, _)| {
            let w = norm(w);
            p == w || p.starts_with(&format!("{w}/"))
        })
        .max_by_key(|(w, _)| w.len())
        .map(|(w, _)| Change::Work(w.clone()))
}

struct State {
    watcher: Option<notify::RecommendedWatcher>,
    roots: Vec<(String, String)>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State { watcher: None, roots: vec![] }));

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Cria o vigia e a thread que agrupa eventos (debounce) e avisa o frontend com `fs-changed`.
pub fn start(app: tauri::AppHandle) {
    use tauri::Emitter;
    let (tx, rx) = mpsc::channel::<String>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        for p in ev.paths {
            let _ = tx.send(p.to_string_lossy().to_string());
        }
    });
    state().watcher = watcher.ok();
    std::thread::spawn(move || while let Ok(first) = rx.recv() {
        let mut paths = vec![first];
        let until = Instant::now() + DEBOUNCE;
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(p) => paths.push(p),
                Err(_) => break,
            }
        }
        let roots = state().roots.clone();
        let mut touched: HashSet<String> = HashSet::new();
        for p in paths {
            match classify(&p, &roots) {
                Some(Change::Work(w)) => {
                    cache::STATUS.invalidate(&w);
                    touched.insert(w);
                }
                Some(Change::Git(r)) => {
                    crate::pending::REFS.invalidate(&r);
                    crate::pending::WORKTREES.invalidate(&r);
                    for (w, repo) in &roots {
                        if repo == &r {
                            cache::STATUS.invalidate(w);
                            touched.insert(w.clone());
                        }
                    }
                }
                None => {}
            }
        }
        if !touched.is_empty() {
            let _ = app.emit("fs-changed", touched.into_iter().collect::<Vec<_>>());
        }
    });
}

/// Passa a vigiar raízes novas (chamado após cada varredura de pendências).
pub fn add_roots(new: Vec<(String, String)>) {
    let mut st = state();
    let mut known: Vec<String> = st.roots.iter().map(|(w, _)| norm(w)).collect();
    for (w, repo) in new {
        let n = norm(&w);
        if known.contains(&n) {
            continue;
        }
        // Pasta dentro de uma raiz já vigiada recursivamente não precisa de outro watch.
        let covered = known.iter().any(|k| n.starts_with(&format!("{k}/")));
        if !covered {
            if let Some(wt) = st.watcher.as_mut() {
                let _ = wt.watch(std::path::Path::new(&w), RecursiveMode::Recursive);
            }
        }
        known.push(n);
        st.roots.push((w, repo));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> Vec<(String, String)> {
        vec![
            (r"C:\repo".into(), r"C:\repo".into()),
            (r"C:\repo\.claude\worktrees\a".into(), r"C:\repo".into()),
            (r"C:\Users\x\.codex\worktrees\b".into(), r"C:\repo".into()),
        ]
    }

    #[test]
    fn arquivo_de_trabalho_aponta_para_a_worktree_mais_especifica() {
        assert!(matches!(classify(r"C:\repo\.claude\worktrees\a\src\x.ts", &roots()), Some(Change::Work(w)) if w == r"C:\repo\.claude\worktrees\a"));
        assert!(matches!(classify(r"C:\repo\src\x.ts", &roots()), Some(Change::Work(w)) if w == r"C:\repo"));
        assert!(matches!(classify(r"C:\Users\x\.codex\worktrees\b\y", &roots()), Some(Change::Work(w)) if w == r"C:\Users\x\.codex\worktrees\b"));
    }

    #[test]
    fn mudanca_no_git_dir_e_do_repositorio() {
        assert!(matches!(classify(r"C:\repo\.git\HEAD", &roots()), Some(Change::Git(r)) if r == r"C:\repo"));
        assert!(matches!(classify(r"C:\repo\.git\worktrees\a\index", &roots()), Some(Change::Git(r)) if r == r"C:\repo"));
        assert!(matches!(classify(r"C:\repo\.git\refs\heads\main", &roots()), Some(Change::Git(_))));
    }

    #[test]
    fn ignora_ruido() {
        for p in [r"C:\repo\node_modules\x\y.js", r"C:\repo\.git\objects\ab\cd", r"C:\repo\.git\index.lock", r"C:\repo\dist\a.js", r"C:\outro\x"] {
            assert!(classify(p, &roots()).is_none(), "{p}");
        }
    }
}
