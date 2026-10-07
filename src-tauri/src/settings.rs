// Configurações do painel, em settings.json na pasta de dados do app.
// Campos ausentes no arquivo (versões antigas) assumem o padrão.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Abre escondido na bandeja quando o Windows inicia o painel.
    pub start_minimized: bool,
    /// Avisos do Windows sobre trabalho esquecido no Git.
    pub notify: bool,
    /// Dias parado antes de avisar.
    pub notify_after_days: i64,
    /// Pastas cujas subpastas com Git entram no painel (além das pastas dos chats).
    pub roots: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        let desktop = std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("Desktop"));
        let roots = desktop
            .map(|d| ["vscode", "Projetos"].iter().map(|s| d.join(s).to_string_lossy().to_string()).collect())
            .unwrap_or_default();
        Self { start_minimized: true, notify: true, notify_after_days: 1, roots }
    }
}

static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
static CURRENT: Mutex<Option<Settings>> = Mutex::new(None);

pub fn init(file: PathBuf) {
    let s = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    *FILE.lock().unwrap() = Some(file);
    *CURRENT.lock().unwrap() = Some(s);
}

pub fn get() -> Settings {
    CURRENT.lock().unwrap().clone().unwrap_or_default()
}

pub fn save(mut s: Settings) -> Result<Settings, String> {
    s.notify_after_days = s.notify_after_days.clamp(1, 30);
    let mut roots: Vec<String> = vec![];
    for r in s.roots.iter().map(|r| r.trim().trim_end_matches(['\\', '/']).to_string()).filter(|r| !r.is_empty()) {
        if !PathBuf::from(&r).is_dir() {
            return Err(format!("A pasta {r} não existe."));
        }
        if !roots.iter().any(|x| x.eq_ignore_ascii_case(&r)) {
            roots.push(r);
        }
    }
    s.roots = roots;
    if let Some(f) = FILE.lock().unwrap().as_ref() {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(f, serde_json::to_string_pretty(&s).unwrap_or_default()).map_err(|e| format!("Não foi possível salvar: {e}"))?;
    }
    *CURRENT.lock().unwrap() = Some(s.clone());
    Ok(s)
}
