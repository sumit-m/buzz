//! Where local repository checkouts live.
//!
//! LOCAL DIVERGENCE, and a deliberate duplicate. The same rule exists twice
//! more — `default_repos_root_candidates` in
//! `desktop/src-tauri/src/commands/project_repo_paths.rs`, and the `[Workspace]`
//! line in `crates/buzz-acp/src/pool.rs` — and it is not shared through
//! `buzz-core` on purpose: a shared helper is a conflict surface every rebase
//! pays for, while a duplicate with a comment naming its twins is free. If you
//! change the rule here, change it there.
//!
//! Resolution order:
//!
//! 1. an explicit path (the `--repos-dir` flag)
//! 2. `BUZZ_REPOS_DIR`
//! 3. `<cwd>/REPOS`, when that directory exists — this is the agent case. An
//!    agent's working directory *is* the nest, which is why the harness tells it
//!    `<cwd>/REPOS` in `[Workspace]`. Gated on existence so a human running the
//!    CLI from an unrelated directory does not silently target `./REPOS`.
//! 4. `~/.buzz/REPOS`

use std::path::{Path, PathBuf};

/// Resolve the repository checkout root.
pub fn resolve_repos_root(explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = std::env::var("BUZZ_REPOS_DIR")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(path));
    }
    if let Some(cwd_repos) = std::env::current_dir().ok().map(|cwd| cwd.join("REPOS")) {
        if cwd_repos.is_dir() {
            return Some(cwd_repos);
        }
    }
    dirs::home_dir().map(|home| home.join(".buzz").join("REPOS"))
}

/// Directory names that could hold a repository's checkout, best first.
///
/// Mirrors `local_repo_candidates` in Desktop: the bare repository name leads
/// because that is what a person reads in a file manager, with the announcement
/// d-tag as the fallback. Keep the order — a clone lands in the first free name,
/// so a lookup that disagrees reports "not cloned" for a checkout that exists.
pub fn local_repo_candidates(dtag: &str, clone_url: Option<&str>) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let mut push = |value: Option<String>| {
        if let Some(value) = value {
            if !candidates.contains(&value) {
                candidates.push(value);
            }
        }
    };
    push(clone_url.and_then(clone_url_repo_name));
    push(sanitize_component(dtag));
    candidates
}

/// The existing checkout for a repository, if there is one.
pub fn find_checkout(root: &Path, dtag: &str, clone_url: Option<&str>) -> Option<PathBuf> {
    local_repo_candidates(dtag, clone_url)
        .into_iter()
        .map(|name| root.join(name))
        .find(|candidate| candidate.join(".git").exists())
}

fn clone_url_repo_name(clone_url: &str) -> Option<String> {
    let trimmed = clone_url.trim_end_matches('/');
    let last = trimmed.rsplit('/').next()?;
    sanitize_component(last.strip_suffix(".git").unwrap_or(last))
}

/// Reject anything that is not a plain directory name — a traversal component
/// or a separator would escape the repos root.
fn sanitize_component(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches(".git").trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        clone_url_repo_name, local_repo_candidates, resolve_repos_root, sanitize_component,
    };

    #[test]
    fn an_explicit_path_wins() {
        let root = resolve_repos_root(Some("/tmp/somewhere")).expect("root");
        assert_eq!(root, std::path::PathBuf::from("/tmp/somewhere"));
    }

    #[test]
    fn blank_explicit_paths_fall_through() {
        // An empty flag value must not resolve to the current directory.
        let root = resolve_repos_root(Some("   ")).expect("root");
        assert_ne!(root, std::path::PathBuf::from(""));
    }

    #[test]
    fn the_clone_url_names_the_directory() {
        assert_eq!(
            clone_url_repo_name("http://host/git/owner/bee-garden"),
            Some("bee-garden".to_string())
        );
        assert_eq!(
            clone_url_repo_name("http://host/git/owner/bee-garden.git"),
            Some("bee-garden".to_string())
        );
        assert_eq!(
            clone_url_repo_name("http://host/git/owner/bee-garden/"),
            Some("bee-garden".to_string())
        );
    }

    #[test]
    fn candidates_lead_with_the_clone_url_name() {
        let candidates =
            local_repo_candidates("some-dtag", Some("http://host/git/owner/bee-garden"));
        assert_eq!(candidates, vec!["bee-garden", "some-dtag"]);
    }

    #[test]
    fn candidates_do_not_repeat_a_matching_name() {
        let candidates = local_repo_candidates("bee-garden", Some("http://host/git/o/bee-garden"));
        assert_eq!(candidates, vec!["bee-garden"]);
    }

    #[test]
    fn traversal_components_are_refused() {
        for bad in ["..", ".", "", "../etc", "a/b", "a\\b"] {
            assert_eq!(sanitize_component(bad), None, "{bad} must not be a name");
        }
        assert!(local_repo_candidates("..", Some("http://host/git/o/..")).is_empty());
    }
}
