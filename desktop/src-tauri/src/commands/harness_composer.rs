use tauri::Manager;

use crate::managed_agents::harness_composer::{
    load_harness_composers, refresh_harness_control as refresh_control, HarnessComposer,
};

fn harness_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("custom_harnesses"))
}

/// Message-box controls declared by custom harnesses (LOCAL DIVERGENCE).
#[tauri::command]
pub async fn list_harness_composers(app: tauri::AppHandle) -> Result<Vec<HarnessComposer>, String> {
    let dir = harness_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_harness_composers(&dir))
        .await
        .map_err(|e| format!("harness composer task failed: {e}"))
}

/// Re-reads one control's options (its menu opened), returning every panel.
#[tauri::command]
pub async fn refresh_harness_control(
    app: tauri::AppHandle,
    harness_id: String,
    control_id: String,
) -> Result<Vec<HarnessComposer>, String> {
    let dir = harness_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || refresh_control(&dir, &harness_id, &control_id))
        .await
        .map_err(|e| format!("harness composer task failed: {e}"))
}
