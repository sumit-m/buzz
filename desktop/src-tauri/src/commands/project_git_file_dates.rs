//! LOCAL DIVERGENCE: each file's created date, for the Files view's "Created"
//! sort. A generated image with a `.json` sidecar beside it (same stem) uses
//! the sidecar's `created_at`, which survives moves; any other file uses its
//! first commit at its path, read from the same newest-first `git log
//! --name-only` the snapshot already runs for "last changed" (a path's last
//! appearance there is its first). Renames aren't followed, which following
//! them per file would cost, so a moved file without a sidecar starts again at
//! its new path.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::project_git_file_content::read_text_content;
use super::project_git_types::ProjectRepoFileInfo;

const IMAGE_EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "gif"];
const MAX_SIDECAR_BYTES: u64 = 64 * 1024;

pub(crate) fn set_created_at(files: &mut [ProjectRepoFileInfo], history: &str, repo_dir: &Path) {
    let first = first_commit_at_by_path(history);
    let paths: HashSet<String> = files.iter().map(|file| file.path.clone()).collect();
    for file in files.iter_mut() {
        file.created_at = sidecar_for(&file.path)
            .filter(|sidecar| paths.contains(sidecar))
            .and_then(|sidecar| {
                read_text_content(repo_dir, &sidecar, None, MAX_SIDECAR_BYTES)
                    .as_deref()
                    .and_then(sidecar_created_at)
            })
            .or_else(|| first.get(&file.path).copied());
    }
}

/// `a/h1.json` for the image `a/h1.jpg`; `None` for anything else.
fn sidecar_for(path: &str) -> Option<String> {
    let (stem, extension) = path.rsplit_once('.')?;
    let name_start = stem.rfind('/').map_or(0, |slash| slash + 1);
    (name_start < stem.len() && IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .then(|| format!("{stem}.json"))
}

fn sidecar_created_at(text: &str) -> Option<i64> {
    let sidecar: serde_json::Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    chrono::DateTime::parse_from_rfc3339(sidecar.get("created_at")?.as_str()?)
        .ok()
        .map(|time| time.timestamp())
}

/// Path → author time of the oldest commit naming it, from `git log
/// --format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s --name-only`.
fn first_commit_at_by_path(history: &str) -> HashMap<String, i64> {
    let mut at = None;
    let mut first = HashMap::new();
    for line in history.lines().filter(|line| !line.trim().is_empty()) {
        if line.contains('\0') {
            at = line
                .split('\0')
                .nth(4)
                .and_then(|time| time.trim().parse().ok());
            continue;
        }
        if let Some(time) = at {
            first.insert(line.to_string(), time);
        }
    }
    first
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(time: i64) -> String {
        format!("h\0s\0a\0e\0{time}\0subject")
    }

    fn file(path: &str) -> ProjectRepoFileInfo {
        ProjectRepoFileInfo {
            path: path.into(),
            kind: "blob".into(),
            size: None,
            preview_content: None,
            last_changed_at: None,
            latest_commit: None,
            created_at: None,
        }
    }

    #[test]
    fn the_oldest_commit_naming_a_path_wins() {
        let history = [
            commit(300),
            "a/h1.jpg".into(),
            String::new(),
            commit(200),
            "a/h1.jpg".into(),
            "b.md".into(),
            String::new(),
            commit(100),
            "b.md".into(),
        ]
        .join("\n");
        let first = first_commit_at_by_path(&history);
        assert_eq!(first.get("a/h1.jpg"), Some(&200));
        assert_eq!(first.get("b.md"), Some(&100));
        assert_eq!(first.get("c.md"), None);
        assert!(first_commit_at_by_path("").is_empty());
    }

    #[test]
    fn images_with_a_sidecar_use_its_generated_date() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a")).unwrap();
        std::fs::write(
            dir.path().join("a/h1.json"),
            r#"{"created_at":"2026-11-18T13:43:36.518Z"}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("a/h2.json"), "not json").unwrap();
        let history = [
            commit(900),
            "a/h1.jpg".into(),
            "a/h2.png".into(),
            "b.md".into(),
        ]
        .join("\n");
        let mut files = [
            file("a/h1.jpg"),
            file("a/h1.json"),
            file("a/h2.png"),
            file("a/h2.json"),
            file("b.md"),
            file("c.jpg"),
        ];
        set_created_at(&mut files, &history, dir.path());
        let created: Vec<Option<i64>> = files.iter().map(|f| f.created_at).collect();
        assert_eq!(
            created,
            [Some(1_795_009_416), None, Some(900), None, Some(900), None]
        );
    }

    #[test]
    fn sidecars_belong_to_images_only() {
        assert_eq!(sidecar_for("a/h1.JPG").as_deref(), Some("a/h1.json"));
        assert_eq!(sidecar_for("h1.webp").as_deref(), Some("h1.json"));
        assert_eq!(sidecar_for("a/notes.md"), None);
        assert_eq!(sidecar_for("a/.png"), None);
        assert_eq!(sidecar_for("Makefile"), None);
    }
}
