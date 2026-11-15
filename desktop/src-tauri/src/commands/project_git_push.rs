use super::project_git::{compare_local_remote_status, ProjectRepoPushResult};
use super::project_git_exec::{run_git, GitAuthConfig};

pub(crate) fn push_project_local_repository_blocking(
    repo_dir: &std::path::Path,
    clone_url: String,
    branch_name: Option<String>,
    base_branch: Option<String>,
    auth: &GitAuthConfig,
) -> Result<ProjectRepoPushResult, String> {
    let status = compare_local_remote_status(
        repo_dir,
        &clone_url,
        branch_name.as_deref(),
        base_branch.as_deref(),
        auth,
    );
    if !status.can_push {
        return Err(status
            .push_block_reason
            .unwrap_or_else(|| "Local checkout cannot be pushed.".to_string()));
    }
    let branch = status
        .remote_branch
        .clone()
        .ok_or_else(|| "No branch selected for push.".to_string())?;
    let commit = status
        .local_head
        .clone()
        .ok_or_else(|| "No local commit selected for push.".to_string())?;
    if status.local_branch.as_deref() != Some(branch.as_str()) && status.remote_head.is_none() {
        run_git(
            &["branch", "-m", "--", branch.as_str()],
            Some(repo_dir),
            auth,
        )?;
    }
    run_git(
        &[
            "push",
            "--end-of-options",
            "origin",
            format!("HEAD:{branch}").as_str(),
        ],
        Some(repo_dir),
        auth,
    )?;

    Ok(ProjectRepoPushResult {
        pushed: true,
        message: format!("Pushed {branch} to remote."),
        branch,
        commit,
        merge_base: status.merge_base,
    })
}

#[cfg(test)]
mod tests {
    use super::push_project_local_repository_blocking;
    use crate::commands::project_git::compare_local_remote_status;
    use crate::commands::project_git_exec::{build_test_git_auth_config, run_git};

    #[test]
    fn first_push_aligns_legacy_master_checkout_to_main() {
        let auth = build_test_git_auth_config().expect("build test git config");
        let root = tempfile::tempdir().expect("create test directory");
        let remote = root.path().join("remote.git");
        let checkout = root.path().join("checkout");
        let remote_path = remote.to_str().expect("remote path");
        let checkout_path = checkout.to_str().expect("checkout path");

        run_git(&["init", "--bare", "--", remote_path], None, &auth).expect("initialize remote");
        run_git(&["init", "--", checkout_path], None, &auth).expect("initialize checkout");
        run_git(
            &["symbolic-ref", "HEAD", "refs/heads/master"],
            Some(&checkout),
            &auth,
        )
        .expect("set legacy branch");
        std::fs::write(checkout.join("README.md"), "first commit\n").expect("write fixture");
        run_git(&["add", "README.md"], Some(&checkout), &auth).expect("stage fixture");
        run_git(
            &[
                "-c",
                "user.name=Buzz Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "Initial commit",
            ],
            Some(&checkout),
            &auth,
        )
        .expect("commit fixture");
        run_git(&["branch", "space"], Some(&checkout), &auth).expect("create second local branch");
        run_git(
            &["remote", "add", "origin", remote_path],
            Some(&checkout),
            &auth,
        )
        .expect("add remote");

        let status = compare_local_remote_status(&checkout, remote_path, Some("main"), None, &auth);
        assert_eq!(status.local_branches, ["master", "space"]);

        let result = push_project_local_repository_blocking(
            &checkout,
            remote_path.to_string(),
            Some("main".to_string()),
            None,
            &auth,
        )
        .expect("publish first commit");

        assert_eq!(result.branch, "main");
        assert_eq!(
            run_git(&["branch", "--show-current"], Some(&checkout), &auth)
                .expect("read local branch")
                .trim(),
            "main"
        );
        assert!(run_git(
            &[
                format!("--git-dir={remote_path}").as_str(),
                "show-ref",
                "--verify",
                "refs/heads/main",
            ],
            None,
            &auth,
        )
        .is_ok());
    }

    fn commit_file(
        checkout: &std::path::Path,
        auth: &crate::commands::project_git_exec::GitAuthConfig,
        contents: &str,
    ) {
        std::fs::write(checkout.join("README.md"), contents).expect("write fixture");
        run_git(&["add", "README.md"], Some(checkout), auth).expect("stage fixture");
        run_git(
            &[
                "-c",
                "user.name=Buzz Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                contents,
            ],
            Some(checkout),
            auth,
        )
        .expect("commit fixture");
    }

    #[test]
    fn first_push_never_renames_over_an_existing_local_branch() {
        let auth = build_test_git_auth_config().expect("build test git config");
        let root = tempfile::tempdir().expect("create test directory");
        let remote = root.path().join("remote.git");
        let checkout = root.path().join("checkout");
        let remote_path = remote.to_str().expect("remote path");
        let checkout_path = checkout.to_str().expect("checkout path");

        run_git(&["init", "--bare", "--", remote_path], None, &auth).expect("initialize remote");
        run_git(&["init", "--", checkout_path], None, &auth).expect("initialize checkout");
        run_git(
            &["symbolic-ref", "HEAD", "refs/heads/main"],
            Some(&checkout),
            &auth,
        )
        .expect("start on main");
        commit_file(&checkout, &auth, "main only\n");
        let main_before = run_git(&["rev-parse", "main"], Some(&checkout), &auth)
            .expect("read main")
            .trim()
            .to_string();
        run_git(&["checkout", "--orphan", "feature"], Some(&checkout), &auth)
            .expect("start unrelated branch");
        commit_file(&checkout, &auth, "feature only\n");
        run_git(
            &["remote", "add", "origin", remote_path],
            Some(&checkout),
            &auth,
        )
        .expect("add remote");

        let status = compare_local_remote_status(&checkout, remote_path, Some("main"), None, &auth);
        assert!(!status.can_push);

        let Err(error) = push_project_local_repository_blocking(
            &checkout,
            remote_path.to_string(),
            Some("main".to_string()),
            None,
            &auth,
        ) else {
            panic!("pushing main from feature must be refused");
        };

        assert_eq!(error, "Local checkout is on a different branch than main.");
        assert_eq!(
            run_git(&["rev-parse", "main"], Some(&checkout), &auth)
                .expect("read main")
                .trim(),
            main_before
        );
        assert_eq!(
            run_git(&["branch", "--show-current"], Some(&checkout), &auth)
                .expect("read local branch")
                .trim(),
            "feature"
        );
    }
}
