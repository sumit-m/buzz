use tauri::Manager;

use crate::managed_agents::harness_composer::{load_harness_composers, HarnessComposer};

/// Message-box controls declared by custom harnesses (LOCAL DIVERGENCE).
#[tauri::command]
pub async fn list_harness_composers(app: tauri::AppHandle) -> Result<Vec<HarnessComposer>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("custom_harnesses");
    tauri::async_runtime::spawn_blocking(move || load_harness_composers(&dir))
        .await
        .map_err(|e| format!("harness composer task failed: {e}"))
}
