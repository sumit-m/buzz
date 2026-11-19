//! LOCAL DIVERGENCE: a generated image's place in a repository, for the image
//! info sidebar's repo button. The image is found by file name, and moved or
//! copied (with its `.json` sidecar) by a commit pushed straight to the branch
//! as the image agent (one of the viewer's managed agents, with the name and
//! email buzz-acp gives its own commits), so the repo history reads the same
//! as its saves. Everything runs on a blobless shallow clone and writes the
//! index by hash, so a move downloads no file contents.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use tauri::{AppHandle, State};

use super::media_download::{fetch_blob_bytes_with_cap, validate_download_url, MAX_DOWNLOAD_BYTES};
use super::project_git_exec::{
    build_git_auth_config, build_git_auth_config_for_keys, clean_branch, run_git,
    validate_workspace_clone_url, GitAuthConfig,
};
use super::project_git_folders::{shallow_clone, ShallowClone};
use super::project_git_workflow::project_owner_identity;
use crate::app_state::AppState;
use crate::managed_agents::load_managed_agents;
use crate::relay::relay_api_base_url_with_override;

const MAX_NAMES: usize = 16;
const MAX_CHANGES: usize = 16;
const MAX_PATH: usize = 512;
const MAX_MESSAGE: usize = 200;
/// As buzz-acp caps an agent's git author name.
const MAX_GIT_NAME: usize = 80;

/// Paths in the branch tip whose file name is one of `names`.
#[tauri::command]
pub async fn find_project_repo_files(
    clone_url: String,
    branch: Option<String>,
    names: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    validate_workspace_clone_url(&clone_url, &state)?;
    if names.is_empty() || names.len() > MAX_NAMES || names.iter().any(|name| !is_file_name(name)) {
        return Err("Invalid file names.".into());
    }
    let auth = build_git_auth_config(&state)?;
    let branch = clean_branch(branch);
    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = tempfile::tempdir().map_err(|error| format!("create temp dir: {error}"))?;
        match shallow_clone(temp_dir.path(), &clone_url, branch.as_deref(), &auth)? {
            Some(ShallowClone { dir, head: Some(_) }) => files_named(&dir, &names, &auth),
            _ => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|error| format!("repo find task failed: {error}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileRename {
    pub from: String,
    pub to: String,
}

/// A file to add, from a relay media URL or inline bytes.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileAdd {
    pub path: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub content_base64: Option<String>,
}

/// Commits renames, additions and deletions to the branch in one commit as
/// `agent_pubkey` and pushes it, rebuilding it once on a newer tip. Returns
/// the commit hash.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn commit_project_repo_files(
    app: AppHandle,
    clone_url: String,
    branch: Option<String>,
    agent_pubkey: String,
    renames: Vec<RepoFileRename>,
    adds: Vec<RepoFileAdd>,
    deletes: Vec<String>,
    message: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_workspace_clone_url(&clone_url, &state)?;
    let count = renames.len() + adds.len() + deletes.len();
    if count == 0 || count > MAX_CHANGES {
        return Err(format!("A commit takes 1-{MAX_CHANGES} file changes."));
    }
    let message = message.trim().to_string();
    if message.is_empty() || message.chars().count() > MAX_MESSAGE || message.contains('\n') {
        return Err("Invalid commit message.".into());
    }
    let paths = renames
        .iter()
        .flat_map(|rename| [&rename.from, &rename.to])
        .chain(adds.iter().map(|add| &add.path))
        .chain(&deletes);
    for path in paths {
        if !is_repo_path(path) {
            return Err(format!("Invalid repository path {path:?}."));
        }
    }

    let relay_base = relay_api_base_url_with_override(&state);
    let mut added = Vec::with_capacity(adds.len());
    for add in adds {
        let bytes = match (add.url, add.content_base64) {
            (Some(url), None) => {
                validate_download_url(&url, &relay_base)?;
                fetch_blob_bytes_with_cap(&url, &state, MAX_DOWNLOAD_BYTES, None).await?
            }
            (None, Some(encoded)) => BASE64
                .decode(encoded)
                .map_err(|error| format!("{}: {error}", add.path))?,
            _ => return Err(format!("{}: give a url or contents, not both.", add.path)),
        };
        added.push((add.path, bytes));
    }

    let (identity, auth) = agent_git_identity(&app, &state, &agent_pubkey)?;
    let branch = clean_branch(branch);
    let changes = Changes {
        renames: renames.into_iter().map(|r| (r.from, r.to)).collect(),
        adds: added,
        deletes,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = tempfile::tempdir().map_err(|error| format!("create temp dir: {error}"))?;
        commit_changes(
            temp_dir.path(),
            &clone_url,
            branch.as_deref(),
            &changes,
            &Commit {
                message: &message,
                name: &identity.0,
                email: &identity.1,
            },
            &auth,
        )
    })
    .await
    .map_err(|error| format!("repo commit task failed: {error}"))?
}

/// The git name, email and push credentials of one of the viewer's managed
/// agents: its display name (or hex key) and `<pubkey>@<relay host>`, `buzz`
/// for a local relay, as buzz-acp sets them for the agent's own commits.
fn agent_git_identity(
    app: &AppHandle,
    state: &AppState,
    agent_pubkey: &str,
) -> Result<((String, String), GitAuthConfig), String> {
    let pubkey = agent_pubkey.trim().to_ascii_lowercase();
    let display_name = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        load_managed_agents(app)?
            .into_iter()
            .find(|record| record.pubkey.eq_ignore_ascii_case(&pubkey))
            .map(|record| record.name)
            .ok_or_else(|| "That agent isn't one of yours.".to_string())?
    };
    let keys = project_owner_identity(app, state, &pubkey)?.keys;
    let host = url::Url::parse(&relay_api_base_url_with_override(state))
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .filter(|host| host != "localhost" && !host.starts_with("127."))
        .unwrap_or_else(|| "buzz".into());
    let name = git_user_name(&display_name).unwrap_or_else(|| pubkey.clone());
    let email = format!("{pubkey}@{host}");
    Ok(((name, email), build_git_auth_config_for_keys(&keys)?))
}

/// A display name git accepts as `user.name`, or `None` when nothing usable
/// is left.
fn git_user_name(raw: &str) -> Option<String> {
    let collapsed = raw
        .split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|c| !c.is_control() && !matches!(c, '<' | '>'))
                .collect::<String>()
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let name: String = collapsed.chars().take(MAX_GIT_NAME).collect();
    let name = name.trim_end().to_string();
    name.chars()
        .any(|c| !matches!(c, ' ' | '"' | '\'' | ',' | ':' | ';' | '\\'))
        .then_some(name)
}

fn is_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_PATH
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

fn is_repo_path(path: &str) -> bool {
    path.len() <= MAX_PATH
        && !path.starts_with(".git/")
        && path.split('/').all(is_file_name)
        && path != ".git"
}

pub(crate) fn files_named(
    repo_dir: &Path,
    names: &[String],
    auth: &GitAuthConfig,
) -> Result<Vec<String>, String> {
    let listing = run_git(
        &["ls-tree", "-r", "--name-only", "-z", "HEAD"],
        Some(repo_dir),
        auth,
    )?;
    Ok(listing
        .split('\0')
        .filter(|path| {
            let name = path.rsplit('/').next().unwrap_or(path);
            !path.is_empty() && names.iter().any(|wanted| wanted == name)
        })
        .map(str::to_string)
        .collect())
}

pub(crate) struct Changes {
    pub renames: Vec<(String, String)>,
    pub adds: Vec<(String, Vec<u8>)>,
    pub deletes: Vec<String>,
}

pub(crate) struct Commit<'a> {
    pub message: &'a str,
    pub name: &'a str,
    pub email: &'a str,
}

pub(crate) fn commit_changes(
    work: &Path,
    clone_url: &str,
    branch: Option<&str>,
    changes: &Changes,
    commit: &Commit,
    auth: &GitAuthConfig,
) -> Result<String, String> {
    let (dir, mut base) = match shallow_clone(work, clone_url, branch, auth)? {
        Some(clone) => (clone.dir, clone.head),
        None => {
            // An empty repository, or a branch that doesn't exist yet.
            let dir = work.join("repo");
            let dir_arg = dir.to_string_lossy().into_owned();
            run_git(&["init", "-q", dir_arg.as_str()], Some(work), auth)?;
            run_git(
                &["remote", "add", "origin", "--", clone_url],
                Some(&dir),
                auth,
            )?;
            (dir, None)
        }
    };
    let branch = match branch {
        Some(branch) => branch.to_string(),
        None if base.is_some() => run_git(&["symbolic-ref", "--short", "HEAD"], Some(&dir), auth)?
            .trim()
            .to_string(),
        None => return Err("Choose a branch for an empty repository.".into()),
    };

    let mut added = Vec::with_capacity(changes.adds.len());
    for (index, (path, bytes)) in changes.adds.iter().enumerate() {
        let file = work.join(format!("add-{index}"));
        std::fs::write(&file, bytes).map_err(|error| format!("{path}: {error}"))?;
        let file_arg = file.to_string_lossy().into_owned();
        let oid = run_git(
            &["hash-object", "-w", "--no-filters", "--", file_arg.as_str()],
            Some(&dir),
            auth,
        )?;
        added.push((path.as_str(), oid.trim().to_string()));
    }

    let refspec = |commit: &str| format!("{commit}:refs/heads/{branch}");
    for attempt in 0..2 {
        let made = build_commit(&dir, base.as_deref(), changes, &added, commit, auth)?;
        match run_git(&["push", "-q", "origin", &refspec(&made)], Some(&dir), auth) {
            Ok(_) => return Ok(made),
            Err(error) if attempt == 0 => {
                // The branch moved on: rebuild the same change on its new tip.
                run_git(
                    &["fetch", "-q", "--depth", "1", "origin", branch.as_str()],
                    Some(&dir),
                    auth,
                )
                .map_err(|_| format!("push rejected: {error}"))?;
                base = Some(
                    run_git(&["rev-parse", "FETCH_HEAD"], Some(&dir), auth)?
                        .trim()
                        .to_string(),
                );
            }
            Err(error) => return Err(format!("push rejected: {error}")),
        }
    }
    unreachable!("the loop returns on its second attempt")
}

fn build_commit(
    dir: &Path,
    base: Option<&str>,
    changes: &Changes,
    added: &[(&str, String)],
    commit: &Commit,
    auth: &GitAuthConfig,
) -> Result<String, String> {
    let git = |args: &[&str]| run_git(args, Some(dir), auth).map(|out| out.trim().to_string());
    match base {
        Some(base) => git(&["read-tree", base])?,
        None => git(&["read-tree", "--empty"])?,
    };
    let entry = |path: &str| -> Result<(String, String), String> {
        let listed = base
            .map(|base| git(&["ls-tree", base, "--", path]))
            .transpose()?
            .unwrap_or_default();
        // `<mode> blob <oid>\t<path>`
        let mut fields = listed.split_whitespace();
        match (fields.next(), fields.next(), fields.next()) {
            (Some(mode), Some("blob"), Some(oid)) => Ok((mode.to_string(), oid.to_string())),
            _ => Err(format!("{path} is no longer in the repository.")),
        }
    };
    for (from, to) in &changes.renames {
        let (mode, oid) = entry(from)?;
        git(&["update-index", "--force-remove", "--", from])?;
        git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("{mode},{oid},{to}"),
        ])?;
    }
    for (path, oid) in added {
        git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("100644,{oid},{path}"),
        ])?;
    }
    for path in &changes.deletes {
        entry(path)?;
        git(&["update-index", "--force-remove", "--", path])?;
    }
    // Without --missing-ok git checks every blob exists, which in a blobless
    // clone fetches them all.
    let tree = git(&["write-tree", "--missing-ok"])?;
    if let Some(base) = base {
        if git(&["rev-parse", &format!("{base}^{{tree}}")])? == tree {
            return Err("Nothing to change: the files are already there.".into());
        }
    }
    let name = format!("user.name={}", commit.name);
    let email = format!("user.email={}", commit.email);
    let mut args = vec![
        "-c",
        name.as_str(),
        "-c",
        email.as_str(),
        "commit-tree",
        tree.as_str(),
        "-m",
        commit.message,
    ];
    if let Some(base) = base {
        args.extend(["-p", base]);
    }
    git(&args)
}

#[cfg(test)]
mod tests {
    use super::super::project_git_folders::test_repo::{auth, git, served};
    use super::*;

    const COMMIT: Commit = Commit {
        message: "Move h1.jpg to art/",
        name: "Mage",
        email: "ab12@buzz",
    };

    fn tree_of(url: &str, root: &Path) -> Vec<String> {
        let check = root.join(format!("check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&check);
        git(root, &["clone", "-q", url, &check.to_string_lossy()]);
        let listing = git(&check, &["ls-tree", "-r", "--name-only", "HEAD"]);
        let _ = std::fs::remove_dir_all(&check);
        listing.lines().map(str::to_string).collect()
    }

    fn work(root: &Path, name: &str) -> std::path::PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_files_by_name_anywhere() {
        let root = tempfile::tempdir().unwrap();
        let url = served(
            root.path(),
            &["README.md", "assets/h1.jpg", "assets/h1.json", "old/h1.jpg"],
        );
        let clone = shallow_clone(&work(root.path(), "w"), &url, Some("main"), &auth())
            .unwrap()
            .unwrap();
        let names = ["h1.jpg".to_string()];
        assert_eq!(
            files_named(&clone.dir, &names, &auth()).unwrap(),
            ["assets/h1.jpg", "old/h1.jpg"]
        );
    }

    #[test]
    fn moves_copies_and_deletes_in_one_commit() {
        let root = tempfile::tempdir().unwrap();
        let url = served(root.path(), &["assets/h1.jpg", "assets/h1.json", "keep.md"]);
        let changes = Changes {
            renames: vec![
                ("assets/h1.jpg".into(), "art/h1.jpg".into()),
                ("assets/h1.json".into(), "art/h1.json".into()),
            ],
            adds: vec![("art/new.json".into(), b"{}".to_vec())],
            deletes: vec!["keep.md".into()],
        };
        let made = commit_changes(
            &work(root.path(), "a"),
            &url,
            Some("main"),
            &changes,
            &COMMIT,
            &auth(),
        )
        .unwrap();
        assert_eq!(made.len(), 40);
        assert_eq!(
            tree_of(&url, root.path()),
            ["art/h1.jpg", "art/h1.json", "art/new.json"]
        );
        // No file contents were fetched: a lazy fetch runs without the
        // relay's credentials, so git would prompt for a password instead.
        let missing = git(
            &root.path().join("a").join("repo"),
            &["rev-list", "--objects", "--missing=print", "HEAD"],
        );
        // The seeded files have the same contents, so one blob, still missing.
        assert_eq!(missing.lines().filter(|l| l.starts_with('?')).count(), 1);

        let again = commit_changes(
            &work(root.path(), "b"),
            &url,
            Some("main"),
            &Changes {
                renames: vec![("assets/h1.jpg".into(), "x/h1.jpg".into())],
                adds: vec![],
                deletes: vec![],
            },
            &COMMIT,
            &auth(),
        );
        assert!(again.unwrap_err().contains("no longer in the repository"));
    }

    #[test]
    fn adds_to_an_empty_repository() {
        let root = tempfile::tempdir().unwrap();
        let url = served(root.path(), &[]);
        let changes = Changes {
            renames: vec![],
            adds: vec![("art/h1.jpg".into(), vec![1, 2, 3])],
            deletes: vec![],
        };
        commit_changes(
            &work(root.path(), "a"),
            &url,
            Some("main"),
            &changes,
            &COMMIT,
            &auth(),
        )
        .unwrap();
        assert_eq!(tree_of(&url, root.path()), ["art/h1.jpg"]);
    }

    #[test]
    fn a_move_onto_the_same_place_changes_nothing() {
        let root = tempfile::tempdir().unwrap();
        let url = served(root.path(), &["a/h1.jpg"]);
        let same = Changes {
            renames: vec![("a/h1.jpg".into(), "a/h1.jpg".into())],
            adds: vec![],
            deletes: vec![],
        };
        let result = commit_changes(
            &work(root.path(), "a"),
            &url,
            Some("main"),
            &same,
            &COMMIT,
            &auth(),
        );
        assert!(result.unwrap_err().contains("Nothing to change"));
    }

    #[test]
    fn commits_carry_the_agent_identity() {
        let root = tempfile::tempdir().unwrap();
        let url = served(root.path(), &["a/h1.jpg"]);
        let changes = Changes {
            renames: vec![("a/h1.jpg".into(), "b/h1.jpg".into())],
            adds: vec![],
            deletes: vec![],
        };
        let made = commit_changes(
            &work(root.path(), "a"),
            &url,
            Some("main"),
            &changes,
            &COMMIT,
            &auth(),
        )
        .unwrap();
        let bare = root.path().join("remote.git");
        assert_eq!(
            git(
                &bare,
                &["log", "-1", "--format=%an <%ae> | %cn <%ce> | %s", &made]
            ),
            "Mage <ab12@buzz> | Mage <ab12@buzz> | Move h1.jpg to art/"
        );
    }

    #[test]
    fn git_names_are_cleaned_like_buzz_acp() {
        assert_eq!(git_user_name("  Mage   Bot "), Some("Mage Bot".into()));
        assert_eq!(git_user_name("<Mage>"), Some("Mage".into()));
        assert_eq!(git_user_name(" ;: "), None);
        assert_eq!(git_user_name("v.2"), Some("v.2".into()));
        assert_eq!(git_user_name(&"m".repeat(90)).unwrap().len(), MAX_GIT_NAME);
    }

    #[test]
    fn paths_are_checked() {
        assert!(is_repo_path("art/h1.jpg"));
        assert!(!is_repo_path("/art/h1.jpg"));
        assert!(!is_repo_path("art//h1.jpg"));
        assert!(!is_repo_path("../h1.jpg"));
        assert!(!is_repo_path(".git/config"));
        assert!(!is_repo_path("art\\h1.jpg"));
        assert!(is_file_name("h1.jpg"));
        assert!(!is_file_name("a/h1.jpg"));
    }
}
