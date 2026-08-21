//! Refusing to open a pull request nobody can review.
//!
//! LOCAL DIVERGENCE. Desktop renders a pull request's diff by fetching its tip
//! commit from the clone URL (`get_project_repo_diff`). A pull request opened
//! on a commit that was never pushed therefore renders **with no diff** — the
//! event is valid, the UI looks fine, and there is nothing to review. It fails
//! silently, which is the worst way for it to fail.
//!
//! Prose in a system prompt is the wrong place to fix that. An agent that
//! forgets produces a broken pull request and no error. So `pr open` checks,
//! the same way `repos clone` writes a git identity rather than telling agents
//! to configure one: remove the failure mode structurally.
//!
//! ## Best-effort by design
//!
//! Every check here needs a local checkout, and `pr open` must keep working
//! without one — CI, scripts, and anything driving the relay directly. So the
//! rule is: **fail only when the answer is provable.**
//!
//! - Not in a checkout, or git is unavailable → say nothing, proceed.
//! - Provably unpushed → refuse, naming the fix.
//! - Anything ambiguous → proceed.
//!
//! A false refusal on a commit that *was* pushed would be worse than the empty
//! diff it replaces, because the empty diff is at least recoverable by pushing.
//! That is also why the ancestry test runs after a `git fetch`: a stale
//! remote-tracking ref is the most likely source of a wrong answer, and
//! `REPOS/` refs go stale whenever Desktop is not running to poll them.

use std::path::Path;

use crate::error::CliError;

/// What the local checkout can prove about a tip commit.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum TipReachability {
    /// The commit is an ancestor of a remote-tracking ref: it is on the remote.
    Pushed,
    /// The commit exists locally and is on no remote-tracking ref.
    NotPushed,
    /// No checkout, no git, or the commit is not known here at all. The caller
    /// is not in a position to judge, so it must not.
    Unknown,
}

/// Turn what git could determine into a decision.
///
/// Split from the git calls so the policy is testable on its own: the only
/// state that blocks is a provable `NotPushed`.
pub(crate) fn verdict(reachability: TipReachability, commit: &str) -> Result<(), CliError> {
    match reachability {
        TipReachability::NotPushed => Err(CliError::Usage(format!(
            "commit {} is not on the remote, so the pull request would render with no diff. \
             Push the branch first: `git push -u origin HEAD`.",
            short(commit)
        ))),
        TipReachability::Pushed | TipReachability::Unknown => Ok(()),
    }
}

fn short(commit: &str) -> &str {
    commit.get(..8).unwrap_or(commit)
}

fn git_in(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()
}

fn git_ok(dir: &Path, args: &[&str]) -> bool {
    git_in(dir, args).is_some_and(|out| out.status.success())
}

/// Ask the checkout whether the tip commit is on the remote.
///
/// `fetch` first, so a stale remote-tracking ref cannot produce a false
/// `NotPushed`. A failing fetch is not fatal — offline is `Unknown`, not a
/// refusal.
pub(crate) fn tip_reachability(dir: &Path, commit: &str) -> TipReachability {
    if !git_ok(dir, &["rev-parse", "--git-dir"]) {
        return TipReachability::Unknown;
    }
    // `^{commit}` so a tag or a tree with the same name cannot answer for it.
    if !git_ok(dir, &["cat-file", "-e", &format!("{commit}^{{commit}}")]) {
        // The commit is not in this checkout, so this checkout knows nothing
        // about whether the remote has it.
        return TipReachability::Unknown;
    }
    let _ = git_in(dir, &["fetch", "--quiet", "origin"]);

    match git_in(dir, &["branch", "--remotes", "--contains", commit]) {
        Some(out) if out.status.success() => {
            let listed = String::from_utf8_lossy(&out.stdout);
            if listed.trim().is_empty() {
                TipReachability::NotPushed
            } else {
                TipReachability::Pushed
            }
        }
        // `--contains` failing is ambiguous, not proof of absence.
        _ => TipReachability::Unknown,
    }
}

/// The remote's default branch, from `refs/remotes/origin/HEAD`.
///
/// This is the *target* of a pull request, and it is not the same thing as
/// `--branch-name`, which names the branch being proposed. Falls back to `main`
/// when the symbolic ref is missing, which is the common case in a clone made
/// without `--set-head`.
pub(crate) fn default_branch(dir: &Path) -> String {
    let fallback = || "main".to_string();
    let Some(out) = git_in(
        dir,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) else {
        return fallback();
    };
    if !out.status.success() {
        return fallback();
    }
    let full = String::from_utf8_lossy(&out.stdout).trim().to_string();
    full.strip_prefix("origin/")
        .filter(|name| !name.is_empty())
        .map(String::from)
        .unwrap_or_else(fallback)
}

/// The merge base of the tip against the repository's default branch, when the
/// caller did not supply one.
///
/// Without it Desktop has to guess where the branch diverged, and guesses wrong
/// on any branch that is not a direct child of the default tip. Computing it is
/// one command in a checkout that already has both commits.
///
/// Returns `None` whenever it cannot be computed — an omitted `merge-base` is
/// how every caller behaves today, so falling back to that is safe.
pub(crate) fn merge_base(dir: &Path, commit: &str, default_branch: &str) -> Option<String> {
    let remote_ref = format!("origin/{default_branch}");
    let out = git_in(dir, &["merge-base", commit, &remote_ref])?;
    if !out.status.success() {
        return None;
    }
    let base = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (base.len() == 40 && base.chars().all(|c| c.is_ascii_hexdigit())).then_some(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The only outcome that may block. Everything else proceeds, because the
    /// command has to keep working outside a checkout.
    #[test]
    fn only_a_provable_absence_refuses() {
        assert!(verdict(TipReachability::Pushed, &"a".repeat(40)).is_ok());
        assert!(verdict(TipReachability::Unknown, &"a".repeat(40)).is_ok());
        let error = verdict(TipReachability::NotPushed, &"a".repeat(40)).unwrap_err();
        assert!(matches!(error, CliError::Usage(_)));
    }

    /// The message has to name the fix. An agent that reads "not on the remote"
    /// and does not read "push the branch first" will retry the same command.
    #[test]
    fn the_refusal_names_the_fix() {
        let error = verdict(TipReachability::NotPushed, &"ab12cd34".repeat(5)).unwrap_err();
        let text = error.to_string();
        assert!(text.contains("git push"), "must name the fix: {text}");
        assert!(text.contains("no diff"), "must say why it matters: {text}");
        assert!(text.contains("ab12cd34"), "must name the commit: {text}");
    }

    // ── against real repositories ─────────────────────────────────────────────

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    /// A remote plus a clone of it, with one commit pushed.
    fn repo_pair() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let root = tempfile::tempdir().expect("temp");
        let remote = root.path().join("remote.git");
        let work = root.path().join("work");
        std::fs::create_dir_all(&remote).expect("mkdir");
        git(
            root.path(),
            &["init", "--bare", "--initial-branch=main", "remote.git"],
        );
        git(
            root.path(),
            &["clone", remote.to_str().expect("utf8"), "work"],
        );
        git(&work, &["config", "user.email", "t@example.com"]);
        git(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("a.txt"), "one").expect("write");
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "one"]);
        git(&work, &["push", "-u", "origin", "main"]);
        (root, remote, work)
    }

    fn head(dir: &Path) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("git runs");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn a_pushed_commit_is_reachable() {
        let (_root, _remote, work) = repo_pair();
        assert_eq!(
            tip_reachability(&work, &head(&work)),
            TipReachability::Pushed
        );
    }

    /// The case the whole module exists for.
    #[test]
    fn an_unpushed_commit_is_refused() {
        let (_root, _remote, work) = repo_pair();
        std::fs::write(work.join("a.txt"), "two").expect("write");
        git(&work, &["commit", "-am", "two"]);
        let tip = head(&work);
        assert_eq!(tip_reachability(&work, &tip), TipReachability::NotPushed);
        assert!(verdict(tip_reachability(&work, &tip), &tip).is_err());
    }

    /// Outside a checkout there is nothing to judge with, and `pr open` must
    /// still work for callers driving the relay directly.
    #[test]
    fn a_directory_that_is_not_a_repository_says_nothing() {
        let empty = tempfile::tempdir().expect("temp");
        assert_eq!(
            tip_reachability(empty.path(), &"a".repeat(40)),
            TipReachability::Unknown
        );
    }

    /// A commit this checkout has never seen tells us nothing about the remote.
    /// Refusing here would block opening a pull request from a sibling clone.
    #[test]
    fn an_unknown_commit_is_not_treated_as_unpushed() {
        let (_root, _remote, work) = repo_pair();
        assert_eq!(
            tip_reachability(&work, &"f".repeat(40)),
            TipReachability::Unknown
        );
    }

    #[test]
    fn the_merge_base_of_a_branch_is_where_it_forked() {
        let (_root, _remote, work) = repo_pair();
        let forked_at = head(&work);
        git(&work, &["checkout", "-b", "feature"]);
        std::fs::write(work.join("b.txt"), "two").expect("write");
        git(&work, &["add", "."]);
        git(&work, &["commit", "-m", "two"]);
        assert_eq!(
            merge_base(&work, &head(&work), "main").as_deref(),
            Some(forked_at.as_str())
        );
    }

    /// `--branch-name` names the branch being proposed; the merge base is taken
    /// against the branch being merged *into*. Confusing the two computes the
    /// base of a branch against itself, which is the branch tip — a diff of
    /// nothing.
    #[test]
    fn the_default_branch_comes_from_the_remote_head() {
        let (_root, _remote, work) = repo_pair();
        git(&work, &["remote", "set-head", "origin", "main"]);
        assert_eq!(default_branch(&work), "main");

        let empty = tempfile::tempdir().expect("temp");
        assert_eq!(default_branch(empty.path()), "main");
    }

    #[test]
    fn an_unresolvable_merge_base_is_none() {
        let (_root, _remote, work) = repo_pair();
        assert!(merge_base(&work, &head(&work), "no-such-branch").is_none());
        let empty = tempfile::tempdir().expect("temp");
        assert!(merge_base(empty.path(), &"a".repeat(40), "main").is_none());
    }
}
