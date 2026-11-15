//! Raw bytes of a repository file, for previews the text reader cannot show
//! (images). Replies with `tauri::ipc::Response` so the renderer gets an
//! ArrayBuffer; an empty reply means the file cannot be previewed.

use super::project_git_exec::{
    build_git_auth_config, clean_branch, clean_target_ref, validate_workspace_clone_url,
};
use super::project_git_file_content::{checkout_project_repo, validate_repo_file_path};
use super::project_repo_paths::find_local_repo_dir;
use crate::app_state::AppState;
use tauri::State;

/// Matches the relay's image upload ceiling.
const MAX_PREVIEW_FILE_BYTES: u64 = 50 * 1024 * 1024;

fn read_file_bytes(repo_dir: &std::path::Path, path: &str, cap: u64) -> Option<Vec<u8>> {
    let full_path = repo_dir.join(path);
    if std::fs::symlink_metadata(&full_path)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let normalized = full_path.canonicalize().ok()?;
    let repo_root = repo_dir.canonicalize().ok()?;
    if !normalized.starts_with(repo_root) {
        return None;
    }
    let metadata = std::fs::metadata(&normalized).ok()?;
    if !metadata.is_file() || metadata.len() > cap {
        return None;
    }
    std::fs::read(normalized).ok()
}

fn response(bytes: Option<Vec<u8>>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(bytes.unwrap_or_default())
}

#[tauri::command]
pub async fn get_project_repo_file_bytes(
    clone_url: String,
    default_branch: Option<String>,
    target_ref: Option<String>,
    target_commit: Option<String>,
    path: String,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    validate_workspace_clone_url(&clone_url, &state)?;
    validate_repo_file_path(&path)?;
    let auth = build_git_auth_config(&state)?;
    let branch = clean_branch(default_branch);
    let target_ref = clean_target_ref(target_ref);
    let target_commit = target_commit
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| matches!(value.len(), 40 | 64))
        .filter(|value| value.chars().all(|c| c.is_ascii_hexdigit()));

    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = tempfile::tempdir().map_err(|error| format!("create temp dir: {error}"))?;
        let repo_dir = temp_dir.path().join("repo");
        checkout_project_repo(
            &repo_dir,
            &clone_url,
            branch.as_deref(),
            target_ref.as_deref(),
            target_commit.as_deref(),
            &auth,
        )?;
        Ok(response(read_file_bytes(
            &repo_dir,
            &path,
            MAX_PREVIEW_FILE_BYTES,
        )))
    })
    .await
    .map_err(|error| format!("repo file bytes task failed: {error}"))?
}

#[tauri::command]
pub async fn get_project_local_repo_file_bytes(
    repos_dir: Option<String>,
    project_dtag: String,
    clone_url: Option<String>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    validate_repo_file_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo_dir =
            find_local_repo_dir(repos_dir.as_deref(), &project_dtag, clone_url.as_deref())?;
        Ok(response(repo_dir.and_then(|dir| {
            read_file_bytes(&dir, &path, MAX_PREVIEW_FILE_BYTES)
        })))
    })
    .await
    .map_err(|error| format!("local repo file bytes task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_binary_files_within_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/a.jpg"), [0xff, 0xd8, 0x00, 0xd9]).unwrap();

        assert_eq!(
            read_file_bytes(dir.path(), "assets/a.jpg", 10),
            Some(vec![0xff, 0xd8, 0x00, 0xd9])
        );
        assert_eq!(read_file_bytes(dir.path(), "assets/a.jpg", 3), None);
        assert_eq!(read_file_bytes(dir.path(), "assets/missing.jpg", 10), None);
        assert_eq!(read_file_bytes(dir.path(), "assets", 10), None);
    }

    #[test]
    fn refuses_paths_outside_the_repository() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(root.path().join("secret.png"), [1, 2, 3]).unwrap();

        assert_eq!(read_file_bytes(&repo, "../secret.png", 10), None);
    }
}
