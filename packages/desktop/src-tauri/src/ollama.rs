// Cross-platform Ollama dependency-resolution helpers (Agent: Ollama).
//
// The desktop app uses Ollama as its LLM runtime. We don't bundle it —
// the binary is ~700 MB and bundling it would explode our installer
// while the upstream installer is already excellent on every platform.
// Instead we detect whether the daemon is running and surface a CTA
// that opens the right per-OS download in the user's default browser.
//
// Three commands, exposed to the JS frontend via tauri::command:
//
//   ollama_check_running()     -> bool      // 1-sec TCP probe to :11434
//   ollama_install_url()       -> String    // per-OS canonical download
//   ollama_open_install_page() -> ()        // opens https://ollama.com/download
//
// We use a raw `TcpStream::connect_timeout` rather than pulling in
// reqwest just to call `/api/tags`. If the TCP port is open, the
// daemon is up — Ollama doesn't share 11434 with anything else by
// convention. This keeps the binary lean and avoids a tokio runtime
// just for one healthcheck.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const OLLAMA_HOST: &str = "127.0.0.1";
const OLLAMA_PORT: u16 = 11434;
const PROBE_TIMEOUT: Duration = Duration::from_millis(1000);

const URL_DOWNLOAD_PAGE: &str = "https://ollama.com/download";
const URL_WIN: &str = "https://ollama.com/download/OllamaSetup.exe";
const URL_MAC: &str = "https://ollama.com/download/Ollama-darwin.zip";
const URL_LINUX: &str = "https://ollama.com/install.sh";

/// Quickly probe whether the local Ollama daemon is reachable.
///
/// Returns `Ok(true)` if a TCP connection to 127.0.0.1:11434 succeeds
/// within 1 second, `Ok(false)` if it doesn't (port closed, daemon
/// down, firewall, …). We never error — "can't reach it" is the
/// answer the UI wants.
#[tauri::command]
pub async fn ollama_check_running() -> Result<bool, String> {
    // Run the blocking connect on a worker thread so we don't pin a
    // Tauri async-runtime worker for up to 1 s.
    let res = tauri::async_runtime::spawn_blocking(|| {
        let addr: SocketAddr = format!("{}:{}", OLLAMA_HOST, OLLAMA_PORT)
            .parse()
            .expect("static ollama addr is valid");
        TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok()
    })
    .await;
    Ok(res.unwrap_or(false))
}

/// The canonical per-OS Ollama installer URL.
///
/// We return the *direct* download (not the landing page) so the UI
/// could in theory drive a transparent download flow later. For the
/// current release we just open the landing page (see
/// `ollama_open_install_page`); this command exists so the frontend
/// can render an "advanced: download manually" link without having
/// to know per-OS file names.
#[tauri::command]
pub async fn ollama_install_url() -> Result<String, String> {
    let url = if cfg!(target_os = "windows") {
        URL_WIN
    } else if cfg!(target_os = "macos") {
        URL_MAC
    } else if cfg!(target_os = "linux") {
        URL_LINUX
    } else {
        // Unknown OS — fall back to the landing page; better than
        // pointing the user at a 404.
        URL_DOWNLOAD_PAGE
    };
    Ok(url.to_string())
}

/// Open https://ollama.com/download in the user's default browser.
///
/// We deliberately point at the landing page (not the per-OS direct
/// download) because the page itself does OS detection and shows
/// hashes / Linux one-liner / homebrew tap — all useful context the
/// raw .exe / .zip can't provide.
#[tauri::command]
pub async fn ollama_open_install_page() -> Result<(), String> {
    open::that(URL_DOWNLOAD_PAGE).map_err(|e| format!("open: {e}"))
}
