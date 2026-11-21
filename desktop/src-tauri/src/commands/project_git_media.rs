//! LOCAL DIVERGENCE: repository files streamed to the webview by byte range
//! (`buzz-repo://`), so a `<video>` reads only what it needs: the header and
//! first frame for a tile, then the rest as it plays. The bytes commands hand
//! over whole files instead, which suits images but not video.
//!
//! A renderer first opens a session for one checkout (a remote ref, in a
//! clone shared with thumbnails and previews that fetches each file when it
//! is first asked for, or a local clone in place) and gets a token;
//! `buzz-repo://localhost/<token>/<path>` then serves that checkout's files.
//! Sessions idle past [`SESSION_IDLE`] are dropped.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{http, Manager, State};

use super::project_git_clones::{Freshness, RemoteRepo, RepoClones};
use super::project_git_exec::{build_git_auth_config, validate_workspace_clone_url};
use super::project_git_file_content::validate_repo_file_path;
use super::project_repo_paths::find_local_repo_dir;
use crate::app_state::AppState;

/// A session no request has touched for this long is removed.
const SESSION_IDLE: Duration = Duration::from_secs(15 * 60);
/// Sessions kept at once; the least recently used goes first.
const MAX_SESSIONS: usize = 8;
/// The most one open-ended range request returns; the player asks again.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;
/// The most a request without a range may read whole.
const MAX_WHOLE: u64 = 50 * 1024 * 1024;

#[derive(Clone)]
enum Source {
    Local(PathBuf),
    Remote(RemoteRepo),
}

struct Session {
    key: String,
    source: Source,
    used: Instant,
}

#[derive(Default)]
pub struct RepoMediaSessions {
    sessions: Mutex<HashMap<String, Session>>,
}

impl RepoMediaSessions {
    fn find(&self, key: &str) -> Option<String> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let (token, session) = sessions.iter_mut().find(|(_, s)| s.key == key)?;
        session.used = Instant::now();
        Some(token.clone())
    }

    fn insert(&self, key: String, source: Source) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        sessions.retain(|_, s| s.used.elapsed() < SESSION_IDLE);
        while sessions.len() >= MAX_SESSIONS {
            let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, s)| s.used)
                .map(|(token, _)| token.clone())
            else {
                break;
            };
            sessions.remove(&oldest);
        }
        sessions.insert(
            token.clone(),
            Session {
                key,
                source,
                used: Instant::now(),
            },
        );
        token
    }

    fn source(&self, token: &str) -> Option<Source> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let session = sessions.get_mut(token)?;
        session.used = Instant::now();
        Some(session.source.clone())
    }
}

#[tauri::command]
pub async fn open_project_repo_media(
    clone_url: String,
    default_branch: Option<String>,
    target_ref: Option<String>,
    target_commit: Option<String>,
    state: State<'_, AppState>,
    sessions: State<'_, RepoMediaSessions>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    validate_workspace_clone_url(&clone_url, &state)?;
    let auth = build_git_auth_config(&state)?;
    let repo = RemoteRepo::new(clone_url, default_branch, target_ref, target_commit);
    let key = format!("remote\n{repo:?}");
    // Synced on every open, a reused session included, so a file pushed since
    // the session opened is found.
    let cloned = repo.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<RepoClones>()
            .files(&cloned, &[], Freshness::Latest, &auth)
    })
    .await
    .map_err(|error| format!("repo media clone task failed: {error}"))??;
    Ok(sessions
        .find(&key)
        .unwrap_or_else(|| sessions.insert(key, Source::Remote(repo))))
}

#[tauri::command]
pub async fn open_project_local_repo_media(
    repos_dir: Option<String>,
    project_dtag: String,
    clone_url: Option<String>,
    sessions: State<'_, RepoMediaSessions>,
) -> Result<Option<String>, String> {
    let dir = tauri::async_runtime::spawn_blocking(move || {
        find_local_repo_dir(repos_dir.as_deref(), &project_dtag, clone_url.as_deref())
    })
    .await
    .map_err(|error| format!("local repo media task failed: {error}"))??;
    Ok(dir.map(|dir| {
        let key = format!("local\n{}", dir.display());
        sessions
            .find(&key)
            .unwrap_or_else(|| sessions.insert(key, Source::Local(dir)))
    }))
}

fn mime_for(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or_default();
    match extension.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/// `<dir>/<path>`, when it is a regular file inside `dir` (no symlinks).
fn file_in(dir: &Path, path: &str) -> Option<PathBuf> {
    validate_repo_file_path(path).ok()?;
    let full = dir.join(path);
    if std::fs::symlink_metadata(&full)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    let normalized = full.canonicalize().ok()?;
    if !normalized.starts_with(dir.canonicalize().ok()?) || !normalized.is_file() {
        return None;
    }
    Some(normalized)
}

/// The inclusive byte range a `Range: bytes=a-b` header asks for, within `len`.
fn requested_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let suffix: u64 = suffix.parse().ok()?;
            (len.saturating_sub(suffix), len - 1)
        }
        (start, "") => {
            let start: u64 = start.parse().ok()?;
            (start, (start + MAX_CHUNK - 1).min(len - 1))
        }
        (start, end) => {
            let start: u64 = start.parse().ok()?;
            let end: u64 = end.parse().ok()?;
            (start, end.min(len - 1).min(start + MAX_CHUNK - 1))
        }
    };
    (start <= end && start < len).then_some((start, end))
}

fn read_range(file: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut handle = std::fs::File::open(file)?;
    handle.seek(SeekFrom::Start(start))?;
    let mut bytes = vec![0; (end - start + 1) as usize];
    handle.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn plain(status: u16, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(message.as_bytes().to_vec())
        .unwrap_or_default()
}

/// The token and file path of `buzz-repo://localhost/<token>/<path>` (the
/// whole remainder may be percent-encoded, slashes included).
fn token_and_path(uri_path: &str) -> Option<(String, String)> {
    let decoded = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?;
    let (token, path) = decoded.split_once('/')?;
    (!token.is_empty() && !path.is_empty()).then(|| (token.to_string(), path.to_string()))
}

/// The clone of `repo` with `path` on disk, as the session first saw it.
fn remote_file_dir(
    app: &tauri::AppHandle,
    repo: &RemoteRepo,
    path: &str,
) -> Result<PathBuf, String> {
    let auth = build_git_auth_config(&app.state::<AppState>())?;
    app.state::<RepoClones>()
        .files(repo, &[path.to_string()], Freshness::AsSynced, &auth)
}

pub fn handle_buzz_repo(
    app: &tauri::AppHandle,
    request: &http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let Some((token, path)) = token_and_path(request.uri().path()) else {
        return plain(404, "not found");
    };
    let dir = match app.state::<RepoMediaSessions>().source(&token) {
        None => return plain(404, "session expired"),
        Some(Source::Local(dir)) => dir,
        Some(Source::Remote(repo)) => match remote_file_dir(app, &repo, &path) {
            Ok(dir) => dir,
            Err(_) => return plain(502, "could not fetch the file"),
        },
    };
    let Some(file) = file_in(&dir, &path) else {
        return plain(404, "not found");
    };
    let Ok(len) = std::fs::metadata(&file).map(|m| m.len()) else {
        return plain(404, "not found");
    };
    let builder = http::Response::builder()
        .header("content-type", mime_for(&path))
        .header("accept-ranges", "bytes")
        // A tile draws a frame to a canvas, which needs a CORS-clean source.
        .header("access-control-allow-origin", "*")
        .header("cache-control", "no-store");
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    let response = match range {
        Some(header) => match requested_range(header, len) {
            Some((start, end)) => read_range(&file, start, end).map(|bytes| {
                builder
                    .status(206)
                    .header("content-range", format!("bytes {start}-{end}/{len}"))
                    .body(bytes)
            }),
            None => {
                return http::Response::builder()
                    .status(416)
                    .header("content-range", format!("bytes */{len}"))
                    .body(Vec::new())
                    .unwrap_or_default()
            }
        },
        None if len > MAX_WHOLE => return plain(413, "too large; request a range"),
        None => std::fs::read(&file).map(|bytes| builder.status(200).body(bytes)),
    };
    match response {
        Ok(Ok(response)) => response,
        _ => plain(500, "could not read the file"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_clamped_to_the_file_and_the_chunk() {
        assert_eq!(requested_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(requested_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(requested_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(requested_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(
            requested_range("bytes=0-", 100 * 1024 * 1024),
            Some((0, MAX_CHUNK - 1))
        );
        assert_eq!(requested_range("bytes=1000-", 1000), None);
        assert_eq!(requested_range("bytes=5-1", 1000), None);
        assert_eq!(requested_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(requested_range("items=0-1", 1000), None);
    }

    #[test]
    fn urls_carry_a_token_then_the_path() {
        assert_eq!(
            token_and_path("/abc/assets/v.mp4"),
            Some(("abc".into(), "assets/v.mp4".into()))
        );
        assert_eq!(
            token_and_path("/abc%2Fassets%2Fmy%20clip.mp4"),
            Some(("abc".into(), "assets/my clip.mp4".into()))
        );
        assert_eq!(token_and_path("/abc"), None);
        assert_eq!(token_and_path("/"), None);
    }

    #[test]
    fn files_stay_inside_the_checkout() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a")).unwrap();
        std::fs::write(dir.path().join("a/v.mp4"), b"0123456789").unwrap();
        assert!(file_in(dir.path(), "a/v.mp4").is_some());
        assert!(file_in(dir.path(), "../outside.mp4").is_none());
        assert!(file_in(dir.path(), "a").is_none());
        let file = file_in(dir.path(), "a/v.mp4").unwrap();
        assert_eq!(read_range(&file, 2, 4).unwrap(), b"234");
        assert_eq!(mime_for("a/v.MP4"), "video/mp4");
    }

    #[test]
    fn sessions_are_reused_by_key_and_capped() {
        let sessions = RepoMediaSessions::default();
        let first = sessions.insert("k0".into(), Source::Local(PathBuf::from("d0")));
        assert_eq!(sessions.find("k0"), Some(first.clone()));
        for i in 1..=MAX_SESSIONS {
            sessions.insert(
                format!("k{i}"),
                Source::Local(PathBuf::from(format!("d{i}"))),
            );
        }
        assert_eq!(sessions.find("k0"), None);
        assert!(sessions.source(&first).is_none());
    }
}
