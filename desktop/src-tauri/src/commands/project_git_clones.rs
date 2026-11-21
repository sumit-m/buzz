//! LOCAL DIVERGENCE: partial clones of project repositories, shared by the
//! Files tab's thumbnails, image previews and video sessions, and kept for
//! [`CLONE_IDLE`] after their last use. A clone checks nothing out; each
//! request fetches only the files it names, in one batch.
//!
//! Clones live under one folder in the temp directory, a subfolder per running
//! app holding a lock file, so a launch can remove what a crashed (or closed)
//! app left behind: [`remove_stale_repo_clones`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::project_git::first_output_line;
use super::project_git_exec::{clean_branch, clean_target_ref, run_git, GitAuthConfig};
use super::project_git_file_content::validate_repo_file_path;

/// A clone no request has touched for this long is removed.
const CLONE_IDLE: Duration = Duration::from_secs(10 * 60);
/// Clones kept at once; the least recently used goes first.
const MAX_CLONES: usize = 8;
/// A branch is synced with the relay at most this often.
const SYNC_AFTER: Duration = Duration::from_secs(5);
/// Blobs asked for in one fetch, which keeps the command line short.
const FETCH_BATCH: usize = 100;
const CLONES_DIR: &str = "buzz-repo-clones";
const OWNER_LOCK: &str = "owner.lock";
/// A folder without a lock file is left alone this long (it may be new).
const UNLOCKED_GRACE: Duration = Duration::from_secs(60);

/// One remote checkout: a branch, or a pinned ref or commit.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct RemoteRepo {
    clone_url: String,
    branch: Option<String>,
    target_ref: Option<String>,
    target_commit: Option<String>,
}

impl RemoteRepo {
    pub(crate) fn new(
        clone_url: String,
        default_branch: Option<String>,
        target_ref: Option<String>,
        target_commit: Option<String>,
    ) -> Self {
        Self {
            clone_url,
            branch: clean_branch(default_branch),
            target_ref: clean_target_ref(target_ref),
            target_commit: target_commit
                .map(|value| value.to_ascii_lowercase())
                .filter(|value| matches!(value.len(), 40 | 64))
                .filter(|value| value.chars().all(|c| c.is_ascii_hexdigit())),
        }
    }
}

/// Whether a branch clone may serve what it last synced.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Freshness {
    /// Sync with the relay first, unless that happened moments ago.
    Latest,
    /// As synced, so a playing video is not swapped mid-stream.
    AsSynced,
}

struct Checkout {
    _dir: tempfile::TempDir,
    repo: PathBuf,
    /// What a sync fetches; `None` for a pinned ref or commit.
    sync_ref: Option<String>,
    rev: String,
    synced: Instant,
    /// Regular files at `rev`, path to blob id.
    blobs: HashMap<String, String>,
    /// Files on disk, path to the blob they hold.
    present: HashMap<String, String>,
}

struct Slot {
    checkout: Mutex<Option<Checkout>>,
    used: Mutex<Instant>,
}

struct Workspace {
    dir: PathBuf,
    _lock: std::fs::File,
}

#[derive(Default)]
pub struct RepoClones {
    workspace: OnceLock<Result<Workspace, String>>,
    slots: Mutex<HashMap<RemoteRepo, Arc<Slot>>>,
}

impl RepoClones {
    /// The working tree of `repo`'s clone, with those of `paths` that are
    /// regular files at its commit on disk.
    pub(crate) fn files(
        &self,
        repo: &RemoteRepo,
        paths: &[String],
        freshness: Freshness,
        auth: &GitAuthConfig,
    ) -> Result<PathBuf, String> {
        let workspace = self.workspace()?;
        let slot = self.slot(repo);
        let mut guard = slot.checkout.lock().unwrap_or_else(|p| p.into_inner());
        let checkout = match &mut *guard {
            Some(checkout) => {
                if freshness == Freshness::Latest && checkout.synced.elapsed() > SYNC_AFTER {
                    checkout.sync(auth)?;
                }
                checkout
            }
            empty => empty.insert(Checkout::clone(workspace, repo, auth)?),
        };
        checkout.materialize(paths, auth)?;
        Ok(checkout.repo.clone())
    }

    /// Removes every clone and this app's folder, for a clean exit.
    pub fn clear(&self) {
        self.slots.lock().unwrap_or_else(|p| p.into_inner()).clear();
        if let Some(Ok(workspace)) = self.workspace.get() {
            let _ = std::fs::remove_dir_all(&workspace.dir);
        }
    }

    fn workspace(&self) -> Result<&Path, String> {
        match self
            .workspace
            .get_or_init(|| Workspace::open(&clones_root()))
        {
            Ok(workspace) => Ok(&workspace.dir),
            Err(error) => Err(error.clone()),
        }
    }

    fn slot(&self, repo: &RemoteRepo) -> Arc<Slot> {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let last_used = |slot: &Slot| *slot.used.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(slot) = slots.get(repo) {
            *slot.used.lock().unwrap_or_else(|p| p.into_inner()) = now;
            return slot.clone();
        }
        slots.retain(|_, slot| now.duration_since(last_used(slot)) < CLONE_IDLE);
        while slots.len() >= MAX_CLONES {
            let Some(oldest) = slots
                .iter()
                .min_by_key(|(_, slot)| last_used(slot))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            slots.remove(&oldest);
        }
        let slot = Arc::new(Slot {
            checkout: Mutex::new(None),
            used: Mutex::new(now),
        });
        slots.insert(repo.clone(), slot.clone());
        slot
    }
}

impl Checkout {
    fn clone(workspace: &Path, repo: &RemoteRepo, auth: &GitAuthConfig) -> Result<Self, String> {
        let dir = tempfile::Builder::new()
            .prefix("repo-")
            .tempdir_in(workspace)
            .map_err(|error| format!("create clone dir: {error}"))?;
        let repo_dir = dir.path().join("repo");
        let repo_path = repo_dir
            .to_str()
            .ok_or_else(|| "temporary repository path is not UTF-8".to_string())?;
        let clone = ["clone", "--filter=blob:none", "--no-checkout"];
        let pinned = repo.target_ref.is_some() || repo.target_commit.is_some();

        let sync_ref = if pinned {
            run_git(
                &[&clone[..], &[&repo.clone_url, repo_path]].concat(),
                None,
                auth,
            )?;
            None
        } else if let Some(branch) = repo.branch.as_deref() {
            let with_branch = [
                &clone[..],
                &["--branch", branch, &repo.clone_url, repo_path],
            ];
            if run_git(&with_branch.concat(), None, auth).is_ok() {
                Some(branch.to_string())
            } else {
                run_git(
                    &[&clone[..], &[&repo.clone_url, repo_path]].concat(),
                    None,
                    auth,
                )?;
                Some("HEAD".to_string())
            }
        } else {
            run_git(
                &[&clone[..], &[&repo.clone_url, repo_path]].concat(),
                None,
                auth,
            )?;
            Some("HEAD".to_string())
        };

        let rev = if pinned {
            fetch_pinned(&repo_dir, repo, auth)?
        } else {
            resolve(&repo_dir, "HEAD", auth)?
        };
        let blobs = list_blobs(&repo_dir, &rev, auth)?;
        Ok(Self {
            _dir: dir,
            repo: repo_dir,
            sync_ref,
            rev,
            synced: Instant::now(),
            blobs,
            present: HashMap::new(),
        })
    }

    fn sync(&mut self, auth: &GitAuthConfig) -> Result<(), String> {
        let Some(sync_ref) = self.sync_ref.as_deref() else {
            return Ok(());
        };
        run_git(&["fetch", "-q", "origin", sync_ref], Some(&self.repo), auth)?;
        let rev = resolve(&self.repo, "FETCH_HEAD", auth)?;
        if rev != self.rev {
            self.blobs = list_blobs(&self.repo, &rev, auth)?;
            self.rev = rev;
            let blobs = &self.blobs;
            let repo = &self.repo;
            self.present.retain(|path, _| {
                let kept = blobs.contains_key(path);
                if !kept {
                    let _ = std::fs::remove_file(repo.join(path));
                }
                kept
            });
        }
        self.synced = Instant::now();
        Ok(())
    }

    fn materialize(&mut self, paths: &[String], auth: &GitAuthConfig) -> Result<(), String> {
        let wanted = wanted_blobs(&self.blobs, &self.present, paths);
        if wanted.is_empty() {
            return Ok(());
        }
        let mut oids: Vec<&str> = wanted.iter().map(|(_, oid)| oid.as_str()).collect();
        oids.sort_unstable();
        oids.dedup();
        for batch in oids.chunks(FETCH_BATCH) {
            let fetch = [
                "-c",
                "fetch.negotiationAlgorithm=noop",
                "fetch",
                "-q",
                "--no-tags",
                "--no-write-fetch-head",
                "--recurse-submodules=no",
                "--filter=blob:none",
                "origin",
            ];
            run_git(&[&fetch[..], batch].concat(), Some(&self.repo), auth)?;
        }

        let list = self
            .repo
            .parent()
            .ok_or_else(|| "clone has no parent folder".to_string())?
            .join("paths");
        let pathspecs: String = wanted
            .iter()
            .map(|(path, _)| format!(":(literal){path}\0"))
            .collect();
        std::fs::write(&list, pathspecs).map_err(|error| format!("write path list: {error}"))?;
        let from_file = format!("--pathspec-from-file={}", list.display());
        run_git(
            &["checkout", &self.rev, &from_file, "--pathspec-file-nul"],
            Some(&self.repo),
            auth,
        )?;
        self.present.extend(wanted);
        Ok(())
    }
}

/// Fetches a pinned ref (or, for a PR pushed as a plain branch, its commit)
/// and returns the commit, which must match a pinned commit.
fn fetch_pinned(
    repo_dir: &Path,
    repo: &RemoteRepo,
    auth: &GitAuthConfig,
) -> Result<String, String> {
    let target = repo
        .target_ref
        .as_deref()
        .or(repo.target_commit.as_deref())
        .ok_or_else(|| "no pinned ref".to_string())?;
    let fetched = run_git(&["fetch", "-q", "origin", target], Some(repo_dir), auth);
    match (fetched, repo.target_commit.as_deref()) {
        (Ok(_), _) => {}
        (Err(_), Some(commit)) if repo.target_ref.is_some() => {
            run_git(&["fetch", "-q", "origin", commit], Some(repo_dir), auth)?;
        }
        (Err(error), _) => return Err(error),
    }
    let rev = resolve(repo_dir, "FETCH_HEAD", auth)?;
    match repo.target_commit.as_deref() {
        Some(expected) if expected != rev => {
            Err("The requested repository ref changed. Refresh and try again.".to_string())
        }
        _ => Ok(rev),
    }
}

fn resolve(repo_dir: &Path, name: &str, auth: &GitAuthConfig) -> Result<String, String> {
    run_git(&["rev-parse", name], Some(repo_dir), auth)
        .ok()
        .and_then(|output| first_output_line(&output))
        .map(|commit| commit.to_ascii_lowercase())
        .ok_or_else(|| "Could not resolve the requested repository ref.".to_string())
}

fn list_blobs(
    repo_dir: &Path,
    rev: &str,
    auth: &GitAuthConfig,
) -> Result<HashMap<String, String>, String> {
    Ok(parse_blobs(&run_git(
        &["ls-tree", "-r", "-z", rev],
        Some(repo_dir),
        auth,
    )?))
}

/// Regular files (no symlinks or submodules) from `ls-tree -r -z` output.
fn parse_blobs(listing: &str) -> HashMap<String, String> {
    listing
        .split('\0')
        .filter_map(|entry| {
            let (meta, path) = entry.split_once('\t')?;
            let mut fields = meta.split(' ');
            let mode = fields.next()?;
            let kind = fields.next()?;
            let oid = fields.next()?;
            (kind == "blob" && matches!(mode, "100644" | "100755"))
                .then(|| (path.to_string(), oid.to_string()))
        })
        .collect()
}

/// The requested files that exist at the clone's commit and are not yet on
/// disk as that version, once each.
fn wanted_blobs(
    blobs: &HashMap<String, String>,
    present: &HashMap<String, String>,
    paths: &[String],
) -> Vec<(String, String)> {
    let mut wanted: Vec<(String, String)> = paths
        .iter()
        .filter(|path| validate_repo_file_path(path).is_ok())
        .filter_map(|path| Some((path.clone(), blobs.get(path)?.clone())))
        .filter(|(path, oid)| present.get(path) != Some(oid))
        .collect();
    wanted.sort_unstable();
    wanted.dedup();
    wanted
}

fn clones_root() -> PathBuf {
    std::env::temp_dir().join(CLONES_DIR)
}

impl Workspace {
    fn open(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|error| format!("create clones dir: {error}"))?;
        let dir = tempfile::Builder::new()
            .prefix("app-")
            .tempdir_in(root)
            .map_err(|error| format!("create clones dir: {error}"))?
            .keep();
        let lock = std::fs::File::create(dir.join(OWNER_LOCK))
            .map_err(|error| format!("create clones lock: {error}"))?;
        lock.lock()
            .map_err(|error| format!("lock clones dir: {error}"))?;
        Ok(Self { dir, _lock: lock })
    }
}

/// Removes the clone folders of apps no longer running (their lock is free).
pub fn remove_stale_repo_clones() {
    remove_stale_in(&clones_root());
}

fn remove_stale_in(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir.is_dir() && is_stale(&dir) {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

fn is_stale(dir: &Path) -> bool {
    match std::fs::File::open(dir.join(OWNER_LOCK)) {
        Ok(lock) => lock.try_lock().is_ok(),
        Err(_) => std::fs::metadata(dir)
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified.elapsed().unwrap_or_default() > UNLOCKED_GRACE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn listing(entries: &[&str]) -> String {
        entries.iter().map(|entry| format!("{entry}\0")).collect()
    }

    #[test]
    fn lists_only_regular_files() {
        let blobs = parse_blobs(&listing(&[
            "100644 blob aa\ta/one.png",
            "100755 blob bb\trun.sh",
            "120000 blob cc\ta/link",
            "160000 commit dd\tvendor/sub",
        ]));
        assert_eq!(blobs.len(), 2);
        assert_eq!(blobs["a/one.png"], "aa");
        assert_eq!(blobs["run.sh"], "bb");
    }

    #[test]
    fn wants_each_missing_or_changed_file_once() {
        let blobs = parse_blobs(&listing(&[
            "100644 blob aa\ta.png",
            "100644 blob bb\tb.png",
            "100644 blob cc\tc.png",
        ]));
        let present = HashMap::from([
            ("a.png".to_string(), "aa".to_string()),
            ("b.png".to_string(), "old".to_string()),
        ]);
        let wanted = wanted_blobs(
            &blobs,
            &present,
            &strings(&["a.png", "b.png", "c.png", "c.png", "gone.png", "../c.png"]),
        );
        assert_eq!(
            wanted,
            [
                ("b.png".to_string(), "bb".to_string()),
                ("c.png".to_string(), "cc".to_string())
            ]
        );
    }

    #[test]
    fn repos_keep_only_valid_pins() {
        let repo = RemoteRepo::new(
            "https://relay/git/x".into(),
            Some("main".into()),
            None,
            Some("ABC".into()),
        );
        assert_eq!(repo.target_commit, None);
        let commit = "A".repeat(40);
        let pinned = RemoteRepo::new("u".into(), None, None, Some(commit));
        assert_eq!(pinned.target_commit, Some("a".repeat(40)));
    }

    #[test]
    fn stale_folders_go_and_live_ones_stay() {
        let root = tempfile::tempdir().unwrap();
        let live = Workspace::open(root.path()).unwrap();
        let crashed = Workspace::open(root.path()).unwrap();
        let crashed_dir = crashed.dir.clone();
        drop(crashed);
        let fresh_unlocked = root.path().join("app-new");
        std::fs::create_dir_all(&fresh_unlocked).unwrap();

        remove_stale_in(root.path());

        assert!(live.dir.exists());
        assert!(!crashed_dir.exists());
        assert!(fresh_unlocked.exists());
    }

    #[test]
    fn fetches_only_the_requested_files() {
        use crate::commands::project_git_folders::test_repo;

        let root = tempfile::tempdir().unwrap();
        let url = test_repo::served(root.path(), &["a/one.png"]);
        let seed = root.path().join("seed");
        for name in ["two.png", "my [clip].mp4"] {
            std::fs::write(seed.join("a").join(name), name).unwrap();
        }
        test_repo::git(&seed, &["add", "."]);
        test_repo::git(&seed, &["commit", "-q", "-m", "more"]);
        test_repo::git(&seed, &["push", "-q", &url, "main"]);
        let auth = test_repo::auth();
        let repo = RemoteRepo::new(url, Some("main".into()), None, None);
        let workspace = tempfile::tempdir().unwrap();
        let mut checkout = Checkout::clone(workspace.path(), &repo, &auth).unwrap();
        assert!(!checkout.repo.join("a/one.png").exists());

        checkout
            .materialize(
                &strings(&["a/one.png", "a/my [clip].mp4", "a/none.png"]),
                &auth,
            )
            .unwrap();

        assert_eq!(
            std::fs::read(checkout.repo.join("a/one.png"))
                .unwrap()
                .len(),
            50_000
        );
        assert!(checkout.repo.join("a/my [clip].mp4").exists());
        assert!(!checkout.repo.join("a/two.png").exists());
        let objects = test_repo::git(
            &checkout.repo,
            &["rev-list", "--objects", "--missing=print", "HEAD"],
        );
        let missing = objects.lines().filter(|line| line.starts_with('?')).count();
        assert_eq!(missing, 1);
    }

    #[test]
    fn a_sync_follows_the_branch() {
        use crate::commands::project_git_folders::test_repo;

        let root = tempfile::tempdir().unwrap();
        let url = test_repo::served(root.path(), &["a/one.png", "a/two.png"]);
        let auth = test_repo::auth();
        let repo = RemoteRepo::new(url.clone(), Some("main".into()), None, None);
        let workspace = tempfile::tempdir().unwrap();
        let mut checkout = Checkout::clone(workspace.path(), &repo, &auth).unwrap();
        let both = strings(&["a/one.png", "a/two.png"]);
        checkout.materialize(&both, &auth).unwrap();

        let seed = root.path().join("seed");
        std::fs::write(seed.join("a/one.png"), "new").unwrap();
        test_repo::git(&seed, &["rm", "-q", "a/two.png"]);
        test_repo::git(&seed, &["commit", "-qam", "change"]);
        test_repo::git(&seed, &["push", "-q", &url, "main"]);
        checkout.sync(&auth).unwrap();
        checkout.materialize(&both, &auth).unwrap();

        assert_eq!(
            std::fs::read_to_string(checkout.repo.join("a/one.png")).unwrap(),
            "new"
        );
        assert!(!checkout.repo.join("a/two.png").exists());
    }
}
