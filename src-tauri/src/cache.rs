//! Caches compartilhados entre a varredura de chats e a de pendências.
//! Cada entrada vale até o vigia de arquivos invalidá-la ou até `MAX_AGE` (segurança).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
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

/// `HashMap::new` não é `const`: o mapa nasce vazio (`None`) e é criado no primeiro uso.
pub struct Cache<T> {
    map: Mutex<Option<HashMap<String, Entry<T>>>>,
}

impl<T: Clone> Cache<T> {
    pub const fn new() -> Self {
        Cache { map: Mutex::new(None) }
    }

    fn with<R>(&self, f: impl FnOnce(&mut HashMap<String, Entry<T>>) -> R) -> R {
        let mut guard = self.map.lock().unwrap_or_else(|e| e.into_inner());
        f(guard.get_or_insert_with(HashMap::new))
    }

    pub fn get(&self, key: &str) -> Option<T> {
        self.with(|m| m.get(&norm(key)).filter(|e| e.at.elapsed() < MAX_AGE).map(|e| e.value.clone()))
    }

    pub fn put(&self, key: &str, value: T) {
        self.with(|m| m.insert(norm(key), Entry { value, at: Instant::now() }));
    }

    pub fn invalidate(&self, key: &str) {
        self.with(|m| m.remove(&norm(key)));
    }

    /// Só para testes: envelhece uma entrada.
    #[cfg(test)]
    fn age(&self, key: &str, by: Duration) {
        self.with(|m| {
            if let Some(e) = m.get_mut(&norm(key)) {
                e.at -= by;
            }
        });
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

// ---------- Estado entre aberturas (estado.json) ----------

pub const STATE_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Saved {
    pub v: u32,
    /// Último GitInfo por id de chat.
    pub git: HashMap<String, crate::GitInfo>,
    /// Última varredura de pendências (instante e itens).
    pub pending: Option<(i64, Vec<crate::pending::Pending>)>,
}

static STATE_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_state_file(p: PathBuf) {
    *STATE_FILE.lock().unwrap_or_else(|e| e.into_inner()) = Some(p);
}

/// Lê o estado salvo; versão diferente ou JSON inválido contam como "sem estado".
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
        c.invalidate("C:/REPO/");
        assert_eq!(c.get("c:/repo"), None);
    }

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
}
