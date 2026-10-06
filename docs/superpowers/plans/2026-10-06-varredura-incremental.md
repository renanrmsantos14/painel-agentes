# Varredura incremental — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abrir o painel em < 1 s com o último estado do Git, atualizar cada linha conforme o git responde, e não rodar git em repouso (vigia de arquivos + caches compartilhados e persistidos).

**Architecture:** Caches globais (`status`, refs, último GitInfo por chat, últimas pendências) em `cache.rs`, com validade de 10 min e invalidação por eventos do vigia (`watch.rs`, crate `notify`). `list_runs` devolve na hora as sementes com o último GitInfo conhecido (`stale: true`) e um job em segundo plano recalcula e emite `run-git` em lotes; `estado.json` em `app_data_dir` guarda GitInfo e pendências entre aberturas. O frontend aplica os eventos por id e recarrega só quando o vigia avisa.

**Tech Stack:** Rust (Tauri 2, serde, notify 8), TypeScript (Vite 7, @tauri-apps/api 2).

**Spec:** `docs/superpowers/specs/2026-10-06-varredura-incremental-design.md`

## Global Constraints

- Git continua como subprocesso (`git(dir, args)` em `lib.rs`); nada de libgit2.
- Validade de segurança dos caches `STATUS`/`REFS`: 10 min.
- Debounce do vigia: 1,5 s por worktree. Debounce do frontend: `run-git` 150 ms, `fs-changed` 1 s.
- Pastas ignoradas pelo vigia: `node_modules`, `target`, `dist`, `.memsearch`, `.git/objects`, `.git/logs`, arquivos `*.lock`.
- `estado.json` versionado (`"v": 1`); versão diferente ou JSON inválido = ignorar.
- Ações existentes (abrir chat/pasta/VS Code, remover worktree) não mudam de contrato.
- Comentários e mensagens de commit em português; UTF-8 preservado; patches pequenos.
- Build/teste Rust: rodar a partir de `src-tauri` com `CARGO_TARGET_DIR="C:/Users/mendo/Desktop/Projetos/Painel Agentes/src-tauri/target"` (reaproveita o cache de compilação do checkout principal; `cargo test --lib` leva ~2–5 min). Frontend: `pnpm -s exec tsc --noEmit`.

---

## Estrutura de arquivos

- Create `src-tauri/src/cache.rs` — `Cache<T>` com validade, `norm()`, `STATUS`/`REFS`, `status(dir)`, `Saved` (persistência de `estado.json`).
- Create `src-tauri/src/watch.rs` — vigia `notify`, `classify()`, debounce e emissão de `fs-changed`.
- Modify `src-tauri/src/pending.rs` — `Refs` compartilhado via cache, `Pending` desserializável, varredura achatada `(repo, worktree)`.
- Modify `src-tauri/src/lib.rs` — `Ctx` usa caches, `list_runs` em duas fases, job de verificação com `run-git`, `LAST`, carga/gravação de `estado.json`, início do vigia.
- Modify `src-tauri/Cargo.toml` — `notify = "8"`.
- Modify `src/main.ts`, `src/style.css` — `stale`, `run-git`, `fs-changed`.

---

### Task 1: `cache.rs` — cache com validade e normalização de caminho

**Files:**
- Create: `src-tauri/src/cache.rs`
- Modify: `src-tauri/src/lib.rs:1` (declarar `mod cache;`), `lib.rs:87-90` (`same_path` passa a usar `cache::norm`)

**Interfaces:**
- Produces: `cache::norm(&str) -> String`; `cache::Cache<T: Clone>` com `new()`, `get(&str) -> Option<T>`, `put(&str, T)`, `invalidate(&str)`, `invalidate_under(&str)`; `cache::MAX_AGE`; `cache::STATUS: Cache<String>`; `cache::status(dir: &str) -> String`.

- [ ] **Step 1: Criar `cache.rs` com os testes**

```rust
//! Caches compartilhados entre a varredura de chats e a de pendências.
//! Cada entrada vale até o vigia de arquivos invalidá-la ou até `MAX_AGE` (segurança).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

pub const MAX_AGE: Duration = Duration::from_secs(10 * 60);

/// Caminho comparável: barras normais, sem barra final, minúsculas (Windows não distingue).
pub fn norm(p: &str) -> String {
    p.trim_start_matches(r"\\?\").replace('\\', "/").trim_end_matches('/').to_lowercase()
}

struct Entry<T> {
    value: T,
    at: Instant,
}

pub struct Cache<T> {
    map: Mutex<HashMap<String, Entry<T>>>,
}

impl<T: Clone> Cache<T> {
    pub const fn new() -> Self {
        Cache { map: Mutex::new(HashMap::new()) }
    }

    pub fn get(&self, key: &str) -> Option<T> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&norm(key)).filter(|e| e.at.elapsed() < MAX_AGE).map(|e| e.value.clone())
    }

    pub fn put(&self, key: &str, value: T) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(norm(key), Entry { value, at: Instant::now() });
    }

    pub fn invalidate(&self, key: &str) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(&norm(key));
    }

    /// Remove a chave e tudo que está dentro dela (ex.: worktrees dentro do repositório).
    pub fn invalidate_under(&self, root: &str) {
        let root = norm(root);
        self.map.lock().unwrap_or_else(|e| e.into_inner()).retain(|k, _| k != &root && !k.starts_with(&format!("{root}/")));
    }

    /// Só para testes: envelhece uma entrada.
    #[cfg(test)]
    fn age(&self, key: &str, by: Duration) {
        if let Some(e) = self.map.lock().unwrap().get_mut(&norm(key)) {
            e.at -= by;
        }
    }
}

/// Saída de `git status --porcelain` por pasta (chats e pendências leem a mesma).
pub static STATUS: Cache<String> = Cache::new();

pub fn status(dir: &str) -> String {
    if let Some(s) = STATUS.get(dir) {
        return s;
    }
    let s = crate::git(dir, &["status", "--porcelain"]).unwrap_or_default();
    STATUS.put(dir, s.clone());
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_iguala_variantes_do_windows() {
        assert_eq!(norm(r"C:\A\b\"), "c:/a/b");
        assert_eq!(norm(r"\\?\C:/A/B"), "c:/a/b");
    }

    #[test]
    fn cache_expira_e_invalida() {
        let c: Cache<u32> = Cache::new();
        c.put(r"C:\repo", 1);
        assert_eq!(c.get("c:/repo/"), Some(1));
        c.age("c:/repo", MAX_AGE + Duration::from_secs(1));
        assert_eq!(c.get("c:/repo"), None);
        c.put("c:/repo", 2);
        c.put("c:/repo/.claude/worktrees/x", 3);
        c.put("c:/repo2", 4);
        c.invalidate_under("c:/repo");
        assert_eq!(c.get("c:/repo"), None);
        assert_eq!(c.get("c:/repo/.claude/worktrees/x"), None);
        assert_eq!(c.get("c:/repo2"), Some(4));
    }
}
```

- [ ] **Step 2: Ligar o módulo e usar `norm` em `same_path`**

Em `lib.rs`, logo após `mod pending;`: `mod cache;`. Trocar `same_path`:

```rust
fn same_path(a: &str, b: &str) -> bool {
    cache::norm(a) == cache::norm(b)
}
```

- [ ] **Step 3: Rodar os testes**

Run (em `src-tauri`): `CARGO_TARGET_DIR="C:/Users/mendo/Desktop/Projetos/Painel Agentes/src-tauri/target" cargo test --lib cache -- --nocapture 2>&1 | grep -E "test result|panicked|error"`
Expected: `2 passed`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/cache.rs src-tauri/src/lib.rs
git commit -m "Adiciona cache compartilhado com validade para status e refs do Git"
```

---

### Task 2: `pending.rs` — refs compartilhadas, status do cache, `Pending` desserializável

**Files:**
- Modify: `src-tauri/src/pending.rs:4-9` (imports), `:19-38` (`Pending`), `:40-74` (`Ref`/`Refs`/`refs`), `:136-156` (`dirty`), `:211-216` (`scan_repo` início), `:283-323` (`repos`), `remove_worktree`
- Modify: `src-tauri/src/lib.rs` onde usa `p.kind`, `chat_agent`, `pending::repos(&Ctx::default(), …)`

**Interfaces:**
- Produces: `pub(crate) struct Refs { heads, remotes, origin_head }` (campos `pub(crate)`), `pub(crate) struct Ref { tip, time, upstream, track }`, `pub(crate) fn refs_cached(repo: &str) -> Arc<Refs>`, `pub fn repos(chat_dirs: &[String]) -> Vec<String>`, `Pending { kind: String, chat_agent: Option<String>, … }` com `Deserialize`.
- Consumes: `cache::status`, `cache::Cache`.

- [ ] **Step 1: `Refs` via cache**

Substituir a definição de `Ref`/`Refs`/`refs` por:

```rust
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
```

(`fn refs(dir)` continua igual, só privada.) Imports: `use crate::cache::{self, Cache}; use std::sync::Arc;`.

- [ ] **Step 2: `Pending` persistível**

```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub key: String,
    /// dirty | unmerged | unpushed | cleanup
    pub kind: String,
    …
    pub chat_agent: Option<String>,
}
```

Em `scan_repo`, a closure `item` recebe `kind: &str` e faz `kind: kind.to_string()`, `key: format!("{kind}|{}|{branch}", path.to_lowercase())`. Em `lib.rs`: `kind_text` usa `match p.kind.as_str()`; `watcher` usa `p.kind != "cleanup"` (compara `String` com `&str`, já compila); `pending_now` faz `p.chat_agent = Some(s.run.agent.to_string())`. Import `serde::Deserialize`.

- [ ] **Step 3: `dirty` e `scan_repo` pelos caches**

```rust
fn dirty(dir: &str) -> (u32, i64) {
    let out = cache::status(dir);
    …resto igual…
}
```

Em `scan_repo`: `let all = refs_cached(repo); … let refs = &all.heads;`. Em `remove_worktree`: `let base = base_of(&refs_cached(&repo))…`; após o `git worktree remove` bem-sucedido: `REFS.invalidate(&repo); cache::STATUS.invalidate(path);`.

- [ ] **Step 4: `repos` sem `Ctx`**

Assinatura `pub fn repos(chat_dirs: &[String]) -> Vec<String>`; remover `let _ = ctx;`. `pub fn scan(chat_dirs: &[String], now: i64)` idem. Em `lib.rs::pending_now`: `pending::scan(&dirs, now_ms())`.

- [ ] **Step 5: Compilar e rodar o teste existente**

Run: `CARGO_TARGET_DIR=… cargo test --lib pending -- --nocapture 2>&1 | grep -E "test result|error"`
Expected: `1 passed` (`remove_so_worktree_limpa_e_mesclada`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pending.rs src-tauri/src/lib.rs
git commit -m "Compartilha refs e git status entre chats e pendências pelo cache"
```

---

### Task 3: `lib.rs` — `Ctx` usa os caches; `LAST` por chat; `scan` dividido em sementes + cálculo

**Files:**
- Modify: `src-tauri/src/lib.rs:266-312` (`Ctx`), `:344-394` (`git_info`), `:474-512` (`scan`/`list_runs`), `Run`

**Interfaces:**
- Produces: `fn seeds(days, archived) -> Vec<Seed>`; `fn compute(seeds: &[Seed], ctx: &Ctx, on_done: impl Fn(usize, Option<GitInfo>) + Sync) ` (calcula em paralelo e chama `on_done(i, git)`); `static LAST: Mutex<HashMap<String, GitInfo>>`; `Run.stale: bool`; `GitInfo: Deserialize`.

- [ ] **Step 1: `Ctx` só guarda `DirInfo`; refs vêm de `pending::refs_cached`**

```rust
#[derive(Default)]
struct Ctx {
    dirs: Mutex<HashMap<String, Option<DirInfo>>>,
}

impl Ctx {
    fn dir(&self, dir: &str) -> Option<DirInfo> {
        …igual, mas `dirty: cache::status(dir).lines().count() as u32`…
    }
}
```

Em `git_info`: `let refs = pending::refs_cached(&d.main_repo); let refs = &refs.heads;` e `let tip = |b: &str| refs.get(b).map(|r| r.tip.clone()).unwrap_or_default();`. Remover `impl Ctx::refs`.

- [ ] **Step 2: `Run.stale` e `GitInfo: Deserialize`**

`#[derive(Serialize, Deserialize, Default, Clone)]` em `GitInfo`; em `Run` adicionar `stale: bool` (inicializar `false` em `claude_seeds` e `codex_seeds`). Import `serde::Deserialize`.

- [ ] **Step 3: Último GitInfo por chat**

```rust
/// Último GitInfo calculado por chat: devolvido na hora na abertura, enquanto o job reverifica.
static LAST: std::sync::LazyLock<Mutex<HashMap<String, GitInfo>>> = std::sync::LazyLock::new(Default::default);
```

- [ ] **Step 4: Dividir `scan`**

```rust
fn seeds(days: i64, archived: bool) -> Vec<Seed> {
    let since = now_ms() - days.max(1) * 86_400_000;
    let mut seeds = claude_seeds(since, archived);
    seeds.extend(codex_seeds(since, archived));
    seeds
}

/// Calcula o Git de cada semente em paralelo; `on_done(i, git)` é chamado assim que cada uma termina.
fn compute(seeds: &[Seed], ctx: &Ctx, on_done: impl Fn(usize, Option<GitInfo>) + Sync) {
    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism().map(|n| n.get() * 2).unwrap_or(8).clamp(4, 16);
    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(seed) = seeds.get(i) else { break };
                let g = git_info(seed, ctx);
                if let Some(g) = &g {
                    LAST.lock().unwrap().insert(seed.run.id.clone(), g.clone());
                }
                on_done(i, g);
            });
        }
    });
}

/// Varredura completa e síncrona (usada pelo `--dump`).
fn scan(days: i64, archived: bool) -> Vec<Run> {
    let seeds = seeds(days, archived);
    let results: Mutex<Vec<Option<GitInfo>>> = Mutex::new((0..seeds.len()).map(|_| None).collect());
    compute(&seeds, &Ctx::default(), |i, g| results.lock().unwrap()[i] = g);
    let infos = results.into_inner().unwrap();
    let mut runs: Vec<Run> = seeds.into_iter().zip(infos).map(|(mut s, g)| { s.run.git = g; s.run }).collect();
    runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    runs
}
```

- [ ] **Step 5: Compilar e rodar o `--dump` (sanidade)**

Run: `CARGO_TARGET_DIR=… cargo build 2>&1 | grep -E "^(error|warning: unused)"` → vazio. Depois, numa pasta temporária: `"…/target/debug/painel-agentes.exe" --dump 3` e `node -e "console.log(require('./painel-dump.json').length)"` → número > 0.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "Separa a varredura de chats em sementes e cálculo paralelo com callback"
```

---

### Task 4: `list_runs` em duas fases com evento `run-git`

**Files:**
- Modify: `src-tauri/src/lib.rs` (`list_runs`, novo `verify_job`, `invoke_handler` inalterado)

**Interfaces:**
- Produces: comando `list_runs(days, archived) -> Vec<Run>` (resposta imediata, `stale: true`, `git = LAST[id]`); evento `run-git` com payload `Vec<RunGit { id: String, git: Option<GitInfo> }>`; `fn save_state()` (Task 5 implementa; aqui é só chamada).
- Consumes: `seeds`, `compute`, `LAST`.

- [ ] **Step 1: Fila e job**

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunGit {
    id: String,
    git: Option<GitInfo>,
}

/// Sementes esperando verificação; um `list_runs` novo substitui a fila (o filtro mudou).
static QUEUE: Mutex<Vec<Seed>> = Mutex::new(Vec::new());
static VERIFYING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const EMIT_EVERY: std::time::Duration = std::time::Duration::from_millis(200);

/// Verifica o Git das sementes em segundo plano e avisa o frontend em lotes de `run-git`.
fn verify_job(app: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        loop {
            let batch: Vec<Seed> = std::mem::take(&mut *QUEUE.lock().unwrap());
            if batch.is_empty() {
                break;
            }
            let (tx, rx) = std::sync::mpsc::channel::<RunGit>();
            let ctx = Ctx::default();
            std::thread::scope(|s| {
                s.spawn(|| {
                    compute(&batch, &ctx, |i, git| {
                        let _ = tx.send(RunGit { id: batch[i].run.id.clone(), git });
                    });
                    drop(tx);
                });
                let mut pending: Vec<RunGit> = vec![];
                let mut last = std::time::Instant::now();
                loop {
                    match rx.recv_timeout(EMIT_EVERY) {
                        Ok(r) => pending.push(r),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    if !pending.is_empty() && last.elapsed() >= EMIT_EVERY {
                        let _ = app.emit("run-git", std::mem::take(&mut pending));
                        last = std::time::Instant::now();
                    }
                }
                if !pending.is_empty() {
                    let _ = app.emit("run-git", pending);
                }
            });
        }
        VERIFYING.store(false, Ordering::SeqCst);
        save_state();
    });
}
```

Atenção: a closure passada a `compute` precisa ser `Sync`; `mpsc::Sender` não é. Use `let tx = Mutex::new(tx);` e `tx.lock().unwrap().send(...)`.

- [ ] **Step 2: Comando**

```rust
#[tauri::command]
async fn list_runs(app: tauri::AppHandle, days: i64, archived: bool) -> Result<Vec<Run>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut seeds = seeds(days, archived);
        let last = LAST.lock().unwrap();
        let runs: Vec<Run> = seeds
            .iter_mut()
            .map(|s| {
                let mut run = Run { git: last.get(&s.run.id).cloned(), stale: true, ..clone_run(&s.run) };
                run
            })
            .collect();
        drop(last);
        *QUEUE.lock().unwrap() = seeds;
        if !VERIFYING.swap(true, Ordering::SeqCst) {
            verify_job(app);
        }
        let mut runs = runs;
        runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        runs
    })
    .await
    .map_err(|e| e.to_string())
}
```

`Run` não é `Clone` (tem `&'static str`, mas pode derivar): adicionar `Clone` ao `derive` de `Run` e `Pr` já é `Clone`; então trocar `clone_run(&s.run)` por `s.run.clone()`.

- [ ] **Step 3: Compilar**

Run: `CARGO_TARGET_DIR=… cargo build 2>&1 | grep -E "^(error|warning)" | head` → vazio.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "list_runs responde na hora com o último Git e reverifica em segundo plano via run-git"
```

---

### Task 5: Persistência em `estado.json`

**Files:**
- Modify: `src-tauri/src/cache.rs` (`Saved`, `load_state`, `save_state`, `STATE_FILE`)
- Modify: `src-tauri/src/lib.rs` (`setup`: definir arquivo e carregar; `pending_cached`: salvar; `save_state` chamada no fim do job)

**Interfaces:**
- Produces: `cache::set_state_file(PathBuf)`, `cache::load_state() -> Option<Saved>`, `cache::save_state(&Saved)`, `pub struct Saved { pub v: u32, pub git: HashMap<String, GitInfo>, pub pending: Option<(i64, Vec<Pending>)> }`.

- [ ] **Step 1: Teste de JSON inválido/versão diferente**

```rust
#[test]
fn estado_invalido_e_ignorado() {
    let f = std::env::temp_dir().join(format!("painel-estado-{}.json", std::process::id()));
    set_state_file(f.clone());
    std::fs::write(&f, "{ nao é json").unwrap();
    assert!(load_state().is_none());
    std::fs::write(&f, r#"{"v":99,"git":{},"pending":null}"#).unwrap();
    assert!(load_state().is_none());
    save_state(&Saved { v: STATE_VERSION, git: HashMap::new(), pending: None });
    assert!(load_state().is_some());
    let _ = std::fs::remove_file(&f);
}
```

- [ ] **Step 2: Implementação em `cache.rs`**

```rust
pub const STATE_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Saved {
    pub v: u32,
    pub git: HashMap<String, crate::GitInfo>,
    pub pending: Option<(i64, Vec<crate::pending::Pending>)>,
}

static STATE_FILE: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

pub fn set_state_file(p: std::path::PathBuf) {
    *STATE_FILE.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
}

pub fn load_state() -> Option<Saved> {
    let f = STATE_FILE.lock().unwrap_or_else(|e| e.into_inner()).clone()?;
    let s: Saved = serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()?;
    (s.v == STATE_VERSION).then_some(s)
}

pub fn save_state(s: &Saved) {
    let Some(f) = STATE_FILE.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    // Grava num temporário e renomeia: um fechamento no meio da escrita não corrompe o arquivo.
    let tmp = f.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(s).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &f);
    }
}
```

`GitInfo` e `pending::Pending` precisam ser `pub` (ou `pub(crate)`) para o `Saved`. `GitInfo` em `lib.rs` vira `pub(crate) struct GitInfo`.

- [ ] **Step 3: Usar em `lib.rs`**

```rust
fn save_state() {
    let git = LAST.lock().unwrap().clone();
    let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner()).clone();
    cache::save_state(&cache::Saved { v: cache::STATE_VERSION, git, pending });
}
```

No `setup`: `cache::set_state_file(app.path().app_data_dir()?.join("estado.json")); if let Some(s) = cache::load_state() { *LAST.lock().unwrap() = s.git; *PENDING.lock().unwrap() = s.pending; }`. Em `pending_cached`, depois de `*slot = Some(...)`: `drop(slot); save_state();` (não segurar o lock durante a gravação). Em `list_pending` com cache válido não grava.

- [ ] **Step 4: Testar**

Run: `CARGO_TARGET_DIR=… cargo test --lib cache 2>&1 | grep -E "test result|error"` → `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cache.rs src-tauri/src/lib.rs
git commit -m "Guarda o último estado do Git e das pendências em estado.json entre aberturas"
```

---

### Task 6: `watch.rs` — vigia de arquivos com classificação testável

**Files:**
- Create: `src-tauri/src/watch.rs`
- Modify: `src-tauri/Cargo.toml` (`notify = "8"`), `src-tauri/src/lib.rs` (`mod watch;`, iniciar no `setup`, registrar raízes após cada varredura de pendências)

**Interfaces:**
- Produces: `watch::classify(path: &str, roots: &[(String, String)]) -> Option<Change>` onde `roots` é `(worktree, repo)`; `enum Change { Work(String /*worktree*/), Git(String /*repo*/) }`; `watch::start(app: AppHandle)`; `watch::add_roots(roots: Vec<(String, String)>)`.
- Evento emitido: `fs-changed` com payload `Vec<String>` (worktrees afetadas).

- [ ] **Step 1: Testes de `classify`**

```rust
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
```

- [ ] **Step 2: Implementação**

```rust
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
    Work(String),
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
    tx: Option<mpsc::Sender<String>>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State { watcher: None, roots: vec![], tx: None }));

/// Cria o vigia e a thread que agrupa eventos (debounce) e avisa o frontend.
pub fn start(app: tauri::AppHandle) {
    use tauri::Emitter;
    let (tx, rx) = mpsc::channel::<String>();
    let watcher = notify::recommended_watcher({
        let tx = tx.clone();
        move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            for p in ev.paths {
                let _ = tx.send(p.to_string_lossy().to_string());
            }
        }
    });
    let mut st = STATE.lock().unwrap();
    st.watcher = watcher.ok();
    st.tx = Some(tx);
    drop(st);
    std::thread::spawn(move || loop {
        let Ok(first) = rx.recv() else { break };
        let mut paths = vec![first];
        let until = Instant::now() + DEBOUNCE;
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(p) => paths.push(p),
                Err(_) => break,
            }
        }
        let roots = STATE.lock().unwrap().roots.clone();
        let mut touched: HashSet<String> = HashSet::new();
        for p in paths {
            match classify(&p, &roots) {
                Some(Change::Work(w)) => {
                    cache::STATUS.invalidate(&w);
                    touched.insert(w);
                }
                Some(Change::Git(r)) => {
                    crate::pending::REFS.invalidate(&r);
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
    let mut st = STATE.lock().unwrap();
    let known: Vec<String> = st.roots.iter().map(|(w, _)| norm(w)).collect();
    for (w, repo) in new {
        let n = norm(&w);
        if known.iter().any(|k| k == &n) {
            continue;
        }
        // Pasta dentro de uma raiz já vigiada recursivamente não precisa de outro watch.
        let covered = known.iter().any(|k| n.starts_with(&format!("{k}/")));
        if !covered {
            if let Some(wt) = st.watcher.as_mut() {
                let _ = wt.watch(std::path::Path::new(&w), RecursiveMode::Recursive);
            }
        }
        st.roots.push((w, repo));
    }
}
```

Mutex poisoning: usar `.lock().unwrap_or_else(|e| e.into_inner())` nos três pontos para o vigia não morrer se outra thread entrou em pânico.

- [ ] **Step 3: Ligar em `lib.rs`**

`Cargo.toml`: `notify = "8"`. `lib.rs`: `mod watch;`; no `setup`, antes de `watcher(app.handle().clone())`: `watch::start(app.handle().clone());`. Em `pending_now`, após `pending::scan`: montar as raízes a partir de `pending::repos(&dirs)` e das worktrees de cada repositório. Para isso, `pending::scan` passa a devolver também as worktrees: alterar para `pub fn scan(chat_dirs, now) -> (Vec<Pending>, Vec<(String, String)>)` onde o segundo é `(worktree_path, repo)` incluindo o próprio repo. `pending_now` chama `watch::add_roots(roots)` e devolve só os itens.

- [ ] **Step 4: Testar**

Run: `CARGO_TARGET_DIR=… cargo test --lib watch 2>&1 | grep -E "test result|error"` → `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/watch.rs src-tauri/src/lib.rs src-tauri/src/pending.rs
git commit -m "Vigia os repositórios com notify e invalida só o que mudou"
```

---

### Task 7: Pendências achatadas em tarefas `(repo, worktree)`

**Files:**
- Modify: `src-tauri/src/pending.rs:211-281` (`scan_repo`), `:325-341` (`scan`)

**Interfaces:**
- Produces: `pub fn scan(chat_dirs: &[String], now: i64) -> (Vec<Pending>, Vec<(String, String)>)` (já prometido na Task 6).

- [ ] **Step 1: Dividir `scan_repo`**

```rust
struct RepoHead {
    repo: String,
    project: String,
    base: String,
    refs: Arc<Refs>,
    worktrees: Vec<Wt>,
}

/// Fase 1 (por repositório): refs, base, lista de worktrees, "sem push" e branches sem worktree.
fn scan_repo_head(repo: &str, now: i64) -> Option<(RepoHead, Vec<Pending>)> {
    let all = refs_cached(repo);
    let base = base_of(&all)?;
    let project = Path::new(repo).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let worktrees = worktrees(repo);
    let with_worktree: HashSet<&str> = worktrees.iter().filter_map(|w| w.branch.as_deref()).collect();
    let mut out = vec![];
    let item = |kind: &str, path: &str, branch: &str, count, last, commits, worktree| item(kind, &project, repo, &base, path, branch, count, last, commits, worktree);
    if !all.remotes.is_empty() {
        if let Some(r) = all.heads.get(&base) {
            let (ahead, commits) = unpushed(repo, &base, r, all.remotes.get(&format!("origin/{base}")));
            if ahead > 0 {
                out.push(item("unpushed", repo, &base, ahead, tip_time(&all.heads, &base), commits, false));
            }
        }
    }
    for (b, r) in &all.heads {
        if *b == base || with_worktree.contains(b.as_str()) || r.tip.is_empty() || now - r.time > BRANCH_MAX_AGE_DAYS * 86_400_000 {
            continue;
        }
        let (ahead, commits) = unmerged_cached(repo, &all.heads, &base, b);
        if ahead > 0 {
            out.push(item("unmerged", repo, b, ahead, r.time, commits, false));
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
```

- [ ] **Step 2: `scan` em duas fases paralelas**

```rust
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

pub fn scan(chat_dirs: &[String], now: i64) -> (Vec<Pending>, Vec<(String, String)>) {
    let repos = repos(chat_dirs);
    let heads: Vec<(RepoHead, Vec<Pending>)> = parallel(&repos, 8, |r| scan_repo_head(r, now).into_iter().collect());
    let mut list: Vec<Pending> = vec![];
    let mut tasks: Vec<(&RepoHead, &Wt)> = vec![];
    let mut roots = vec![];
    for (h, items) in &heads {
        list.extend(items.iter().cloned());
        roots.push((h.repo.clone(), h.repo.clone()));
        for wt in &h.worktrees {
            tasks.push((h, wt));
            roots.push((wt.path.clone(), h.repo.clone()));
        }
    }
    list.extend(parallel(&tasks, 8, |(h, wt)| scan_worktree(h, wt)));
    list.sort_by(|a, b| a.last_activity.cmp(&b.last_activity));
    (list, roots)
}
```

- [ ] **Step 3: Testar e comparar saída**

Run: `CARGO_TARGET_DIR=… cargo test --lib 2>&1 | grep -E "test result|error"` → todos passam. Depois `cargo build` e `--dump 7` numa pasta temporária; comparar `painel-pendencias.json` com o da varredura anterior (mesmas `key`s; `count` pode diferir só onde houve mudança real).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pending.rs src-tauri/src/lib.rs
git commit -m "Varre pendências em duas fases paralelas: por repositório e por worktree"
```

---

### Task 8: Frontend — `stale`, `run-git`, `fs-changed`

**Files:**
- Modify: `src/main.ts` (`Run` type, `load`, listeners, resumo), `src/style.css`

**Interfaces:**
- Consumes: `list_runs` → `Run[]` com `stale`; eventos `run-git` (`{id, git}[]`) e `fs-changed` (`string[]`).

- [ ] **Step 1: Tipo e estado**

Em `type Run` adicionar `stale: boolean`. Em `pendAsRun` incluir `stale: false`.

- [ ] **Step 2: Aplicar `run-git` com debounce**

Logo após `async function loadPending` adicionar:

```ts
// ---------- Reverificação em segundo plano ----------
let patchTimer = 0
function schedulePatch() {
  clearTimeout(patchTimer)
  patchTimer = window.setTimeout(() => { link(); renderProjects(); render() }, 150)
}
if (IN_TAURI) {
  void listen<{ id: string; git: GitInfo | null }[]>('run-git', (e) => {
    const byRun = new Map(runs.map((r) => [r.id, r]))
    let touched = false
    for (const { id, git } of e.payload) {
      const r = byRun.get(id)
      if (!r) continue
      r.git = git; r.stale = false; touched = true
    }
    if (touched) schedulePatch()
  })
  // O vigia de arquivos avisou que uma pasta mudou: recarrega (agrupando várias pastas numa só).
  let fsTimer = 0
  void listen<string[]>('fs-changed', () => {
    clearTimeout(fsTimer)
    fsTimer = window.setTimeout(async () => { if (await onScreen()) void load() }, 1000)
  })
}
```

`onScreen` já existe mais abaixo no arquivo (é `async function`, içada), então pode ser usada aqui.

- [ ] **Step 3: Indicador de linhas em reverificação**

Em `label()`, após o `<span class="badge">…</span>`: `${r.stale ? '<i class="verifying" title="Reverificando o Git"></i>' : ''}`. Em `project()`, na classe da `trow`: `` `trow${r.archived ? ' archived' : ''}${r.stale ? ' stale' : ''}` ``. No resumo (`parts` em `render`): `const verifying = all.filter((r) => r.stale).length` e `verifying ? `reverificando ${plural(verifying, 'pasta', 'pastas')}` : ''` antes de `atualizado …`.

CSS (`style.css`, perto de `.live`):

```css
/* Linha com o último estado conhecido, ainda sem resposta do git nesta abertura. */
.trow.stale .badge { opacity: .6; }
.verifying { width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid var(--bt-color-text-secondary); flex: none; animation: blink 1.2s ease-in-out infinite; }
```

(`@keyframes blink` já existe no arquivo.)

- [ ] **Step 4: Conferir tipos e build**

Run: `pnpm -s exec tsc --noEmit && pnpm -s exec vite build 2>&1 | tail -3` → sem erros.

- [ ] **Step 5: Testar no navegador com mock**

Servir `dist` (`pnpm exec vite preview --port 45299 --strictPort`, em segundo plano) com `dist/mock-runs.json` e `dist/mock-pending.json`; abrir no navegador interno; conferir: sem erros no console; `document.querySelectorAll('.trow[data-id]').length > 0`. (Fora do Tauri os eventos não existem; a aplicação do `run-git` é validada no app instalado.)

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/style.css
git commit -m "Mostra o último estado na hora e aplica a reverificação do Git por evento"
```

---

### Task 9: Medição e limpeza final

**Files:**
- Modify: `scripts/profile-pending.cjs` (sem mudança obrigatória); nenhum arquivo novo.

- [ ] **Step 1: Processos git por varredura**

Numa pasta temporária: `GIT_TRACE2=$PWD/trace.txt "…/target/debug/painel-agentes.exe" --dump 7` duas vezes seguidas no mesmo processo não é possível pelo `--dump`; use o teste temporário abaixo (não commitar):

```rust
#[cfg(test)]
mod tmp_bench {
    #[test]
    #[ignore]
    fn warm() {
        for i in 0..2 {
            let t = std::time::Instant::now();
            let r = super::scan(7, false).len();
            let a = t.elapsed();
            let t = std::time::Instant::now();
            let p = super::pending_now().len();
            println!("rodada {i}: list_runs {r} em {:?} | pendencias {p} em {:?}", a, t.elapsed());
        }
    }
}
```

Run: `GIT_TRACE2=$PWD/trace.txt CARGO_TARGET_DIR=… cargo test --release --lib tmp_bench -- --ignored --nocapture 2>&1 | grep rodada`; depois `grep -c ' version ' trace.txt`.
Expected: rodada 1 com zero processos `git status`/`for-each-ref` novos (contagem total da rodada 1 próxima de zero). Remover o módulo temporário depois.

- [ ] **Step 2: `cargo clippy` e testes**

Run: `CARGO_TARGET_DIR=… cargo clippy --quiet 2>&1 | grep -E "^(warning|error)" | head; cargo test --lib 2>&1 | grep "test result"` → sem warnings novos; todos os testes passam.

- [ ] **Step 3: Commit final (só se algo mudou)**

```bash
git status --short
git commit -am "Ajustes finais da varredura incremental"
```

---

## Entrega ao usuário

Depois da Task 9: informar as medições (processos git frio × quente, tempo até o primeiro render) e o que testar no app instalado após a release: abrir e ver o painel completo em < 1 s; editar um arquivo no VS Code e ver a linha mudar em ~2 s; fazer um commit e ver a contagem mudar.
