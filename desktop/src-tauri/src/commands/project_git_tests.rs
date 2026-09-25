use super::super::project_git_file_content::{
    content_cap, read_text_content, validate_repo_file_path,
};
use super::*;

#[test]
fn parse_ls_tree_keeps_paths_after_eager_preview_limit() {
    let repo_dir = tempfile::tempdir().expect("create temporary repository");
    std::fs::create_dir(repo_dir.path().join("src")).expect("create source directory");
    std::fs::write(repo_dir.path().join("README.md"), "# Deferred README")
        .expect("write deferred README");
    std::fs::write(
        repo_dir.path().join("src/application.rs"),
        "fn deferred() {}",
    )
    .expect("write deferred source file");
    let hidden_entries = (0..MAX_EAGER_FILE_PREVIEWS)
        .map(|index| {
            format!(
                "100644 blob {} 1\t.agents/generated-{index:03}.txt",
                "a".repeat(40)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let output = format!(
        "{hidden_entries}\n100644 blob {} 17\tREADME.md\n100644 blob {} 16\tsrc/application.rs",
        "b".repeat(40),
        "c".repeat(40)
    );

    let files = parse_ls_tree(repo_dir.path(), &output, &std::collections::HashMap::new());

    assert_eq!(files.len(), MAX_EAGER_FILE_PREVIEWS + 2);
    let readme = files
        .iter()
        .find(|file| file.path == "README.md")
        .expect("README metadata remains visible");
    assert_eq!(readme.preview_content, None);
    assert_eq!(
        read_preview_content(repo_dir.path(), &readme.path, readme.size).as_deref(),
        Some("# Deferred README")
    );
    assert_eq!(
        files.last().map(|file| file.path.as_str()),
        Some("src/application.rs")
    );
    let source = files.last().expect("source metadata remains visible");
    assert_eq!(source.preview_content, None);
    assert_eq!(
        read_preview_content(repo_dir.path(), &source.path, source.size).as_deref(),
        Some("fn deferred() {}")
    );
}

#[test]
fn repo_file_paths_reject_traversal_and_absolute_paths() {
    assert!(validate_repo_file_path("src/application.rs").is_ok());
    assert!(validate_repo_file_path("../outside.txt").is_err());
    assert!(validate_repo_file_path("src/../outside.txt").is_err());
    assert!(validate_repo_file_path("/absolute.txt").is_err());
}

#[test]
fn parse_ls_tree_counts_only_blobs_toward_eager_preview_limit() {
    let repo_dir = tempfile::tempdir().expect("create temporary repository");
    std::fs::write(repo_dir.path().join("application.rs"), "fn main() {}")
        .expect("write preview file");
    let non_blob_entries = (0..MAX_EAGER_FILE_PREVIEWS)
        .map(|index| {
            format!(
                "160000 commit {} -\tvendor/dependency-{index:03}",
                "a".repeat(40)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let output = format!(
        "{non_blob_entries}\n100644 blob {} 12\tapplication.rs",
        "b".repeat(40)
    );

    let files = parse_ls_tree(repo_dir.path(), &output, &std::collections::HashMap::new());

    assert_eq!(
        files
            .last()
            .and_then(|file| file.preview_content.as_deref()),
        Some("fn main() {}")
    );
}

#[test]
fn parse_worktree_files_counts_only_files_toward_eager_preview_limit() {
    let repo_dir = tempfile::tempdir().expect("create temporary repository");
    std::fs::create_dir(repo_dir.path().join("directory")).expect("create directory");
    let paths = (0..MAX_EAGER_FILE_PREVIEWS)
        .map(|index| {
            let path = format!("file-{index:03}.txt");
            std::fs::write(repo_dir.path().join(&path), "preview").expect("write preview file");
            path
        })
        .collect::<Vec<_>>();
    let output = std::iter::once("directory")
        .chain(paths.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join("\0");

    let files = parse_worktree_files(repo_dir.path(), &output, &std::collections::HashMap::new());

    assert_eq!(files.len(), MAX_EAGER_FILE_PREVIEWS);
    assert!(files.iter().all(|file| file.preview_content.is_some()));
}

#[test]
fn rendering_a_file_reads_past_the_preview_cap_up_to_the_render_cap() {
    let repo_dir = tempfile::tempdir().expect("create temporary repository");
    let report = "x".repeat(200 * 1024);
    std::fs::write(repo_dir.path().join("report.html"), &report).expect("write report");

    assert_eq!(
        read_preview_content(repo_dir.path(), "report.html", None),
        None
    );
    assert_eq!(
        read_text_content(
            repo_dir.path(),
            "report.html",
            None,
            content_cap(Some(u64::MAX))
        )
        .map(|content| content.len()),
        Some(report.len())
    );
    assert_eq!(content_cap(None), 64 * 1024);
    assert_eq!(content_cap(Some(u64::MAX)), 8 * 1024 * 1024);
}

#[test]
fn pull_request_checkout_falls_back_to_its_commit_without_a_nostr_ref() {
    use super::super::project_git_exec::{build_test_git_auth_config, run_git};
    use super::super::project_git_file_content::checkout_project_repo;

    let auth = build_test_git_auth_config().expect("build test git config");
    let root = tempfile::tempdir().expect("create test directory");
    let remote = root.path().join("remote.git");
    let worktree = root.path().join("worktree");
    let remote_path = remote.to_str().expect("remote path");
    let worktree_path = worktree.to_str().expect("worktree path");
    run_git(&["init", "--bare", "--", remote_path], None, &auth).expect("init remote");
    run_git(&["init", "--", worktree_path], None, &auth).expect("init worktree");
    std::fs::write(worktree.join("report.html"), "<!doctype html>").expect("write report");
    run_git(&["add", "report.html"], Some(&worktree), &auth).expect("stage report");
    run_git(
        &[
            "-c",
            "user.name=Buzz Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "Add report",
        ],
        Some(&worktree),
        &auth,
    )
    .expect("commit report");
    let commit = run_git(&["rev-parse", "HEAD"], Some(&worktree), &auth)
        .expect("resolve commit")
        .trim()
        .to_string();
    run_git(
        &["push", remote_path, "HEAD:refs/heads/comparison"],
        Some(&worktree),
        &auth,
    )
    .expect("push branch");

    let checkout = root.path().join("checkout");
    checkout_project_repo(
        &checkout,
        remote_path,
        None,
        Some("refs/nostr/missing"),
        Some(&commit),
        &auth,
    )
    .expect("checkout by commit");

    assert_eq!(
        read_preview_content(&checkout, "report.html", None).as_deref(),
        Some("<!doctype html>")
    );
}
