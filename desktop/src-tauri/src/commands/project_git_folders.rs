//! LOCAL DIVERGENCE: a repository's folders, for the message box's repo:folder
//! picker. A blobless shallow clone holds the latest commit's folder listings
//! but no file contents, so even a large image repository costs a few KB on a
//! relay that serves partial clones; any other relay falls back to a full
//! shallow clone, which is slower but still correct.

use std::path::{Path, PathBuf};

use tauri::State;

use super::project_git_exec::{
    build_git_auth_config, clean_branch, run_git, validate_workspace_clone_url, GitAuthConfig,
};
use crate::app_state::AppState;

const MAX_FOLDERS: usize = 5000;

#[tauri::command]
pub async fn get_project_repo_folders(
    clone_url: String,
    branch: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    validate_workspace_clone_url(&clone_url, &state)?;
    let auth = build_git_auth_config(&state)?;
    let branch = clean_branch(branch);
    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = tempfile::tempdir().map_err(|error| format!("create temp dir: {error}"))?;
        list_repo_folders(temp_dir.path(), &clone_url, branch.as_deref(), &auth)
    })
    .await
    .map_err(|error| format!("repo folders task failed: {error}"))?
}

/// A blobless, depth-1 clone without a checkout: folder listings and file
/// hashes, no file contents.
pub(crate) struct ShallowClone {
    pub dir: PathBuf,
    /// `None` for an empty repository.
    pub head: Option<String>,
}

/// Clones `clone_url` into `work/repo`. `None` when the repository is empty or
/// has no `branch` yet.
pub(crate) fn shallow_clone(
    work: &Path,
    clone_url: &str,
    branch: Option<&str>,
    auth: &GitAuthConfig,
) -> Result<Option<ShallowClone>, String> {
    let repo_dir = work.join("repo");
    let repo_arg = repo_dir.to_string_lossy().into_owned();
    let mut args = vec![
        "clone",
        "-q",
        "--depth",
        "1",
        "--filter=blob:none",
        "--no-checkout",
    ];
    if let Some(branch) = branch {
        args.extend(["--branch", branch]);
    }
    args.extend([clone_url, repo_arg.as_str()]);
    if let Err(error) = run_git(&args, Some(work), auth) {
        let lower = error.to_ascii_lowercase();
        if lower.contains("not found in upstream") || lower.contains("empty repository") {
            return Ok(None);
        }
        return Err(format!("clone failed: {error}"));
    }
    let head = run_git(
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        Some(&repo_dir),
        auth,
    )
    .ok()
    .map(|output| output.trim().to_string())
    .filter(|commit| !commit.is_empty());
    Ok(Some(ShallowClone {
        dir: repo_dir,
        head,
    }))
}

pub(crate) fn list_repo_folders(
    work: &Path,
    clone_url: &str,
    branch: Option<&str>,
    auth: &GitAuthConfig,
) -> Result<Vec<String>, String> {
    // An empty repository, or one without that branch yet, has no folders.
    let Some(ShallowClone {
        dir: repo_dir,
        head: Some(_),
    }) = shallow_clone(work, clone_url, branch, auth)?
    else {
        return Ok(Vec::new());
    };
    let listing = run_git(
        &["ls-tree", "-r", "-d", "--name-only", "-z", "HEAD"],
        Some(&repo_dir),
        auth,
    )?;
    Ok(listing
        .split('\0')
        .filter(|path| !path.is_empty())
        .take(MAX_FOLDERS)
        .map(str::to_string)
        .collect())
}

/// A local bare repository served over `file://`, for tests.
#[cfg(test)]
pub(crate) mod test_repo {
    use std::path::Path;

    use crate::commands::project_git_exec::{build_test_git_auth_config, GitAuthConfig};

    pub(crate) fn auth() -> GitAuthConfig {
        build_test_git_auth_config().expect("git on PATH")
    }

    /// Runs git and returns its trimmed output.
    pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// The bare repo's `file://` URL, seeded with `files` (50 KB each) on `main`.
    pub(crate) fn served(root: &Path, files: &[&str]) -> String {
        let bare = root.join("remote.git");
        git(
            root,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                &bare.to_string_lossy(),
            ],
        );
        git(&bare, &["config", "uploadpack.allowFilter", "true"]);
        let url = format!(
            "file:///{}",
            bare.to_string_lossy()
                .replace('\\', "/")
                .trim_start_matches('/')
        );
        if !files.is_empty() {
            let seed = root.join("seed");
            git(root, &["init", "-q", "-b", "main", &seed.to_string_lossy()]);
            for file in files {
                let path = seed.join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, vec![7u8; 50_000]).unwrap();
            }
            git(&seed, &["add", "."]);
            git(&seed, &["commit", "-q", "-m", "seed"]);
            git(&seed, &["push", "-q", &url, "main"]);
        }
        url
    }
}

#[cfg(test)]
mod tests {
    use super::test_repo::{auth, served};
    use super::*;

    #[test]
    fn lists_nested_folders() {
        let root = tempfile::tempdir().unwrap();
        let url = served(
            root.path(),
            &[
                "README.md",
                "assets/a.jpg",
                "assets/foxes/b.jpg",
                "img/hero/c.png",
            ],
        );
        let work = root.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        let folders = list_repo_folders(&work, &url, Some("main"), &auth()).unwrap();
        assert_eq!(folders, ["assets", "assets/foxes", "img", "img/hero"]);
    }

    #[test]
    fn empty_repository_has_no_folders() {
        let root = tempfile::tempdir().unwrap();
        let url = served(root.path(), &[]);
        let work = root.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        assert!(list_repo_folders(&work, &url, Some("main"), &auth())
            .unwrap()
            .is_empty());
    }
}
