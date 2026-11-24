//! Thumbnails for a folder of repository images, for the Files tab's tiles
//! view. A remote repository fetches only the requested images, into a clone
//! shared with previews (`project_git_clones`). Files that cannot be
//! thumbnailed are left out; the renderer shows them as icon tiles. Each
//! thumbnail is sent on `on_thumbnail` as soon as it is made, and the command
//! returns the paths that got one.

use std::io::Cursor;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use super::project_git_clones::{Freshness, RemoteRepo, RepoClones};
use super::project_git_exec::{build_git_auth_config, validate_workspace_clone_url};
use super::project_git_file_bytes::{read_file_bytes, MAX_PREVIEW_FILE_BYTES};
use super::project_git_file_content::validate_repo_file_path;
use super::project_repo_paths::find_local_repo_dir;
use crate::app_state::AppState;

const MAX_THUMBNAIL_PATHS: usize = 300;
const THUMBNAIL_EDGE: u32 = 480;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 64_000_000;
const MAX_SVG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoThumbnail {
    path: String,
    /// Source dimensions; 0 when unknown (SVG).
    width: u32,
    height: u32,
    data_url: String,
}

fn raster_thumbnail(bytes: &[u8]) -> Option<(u32, u32, String)> {
    let format = image::guess_format(bytes).ok()?;
    let reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = image::ImageDecoder::dimensions(&decoder);
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        return None;
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_PIXELS * 4);
    image::ImageDecoder::set_limits(&mut decoder, limits).ok()?;
    let orientation = image::ImageDecoder::orientation(&mut decoder)
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut decoded = image::DynamicImage::from_decoder(decoder).ok()?;
    decoded.apply_orientation(orientation);
    let (width, height) = (decoded.width(), decoded.height());
    let thumb = decoded.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE);

    let mut output = Vec::new();
    let mime = if thumb.color().has_alpha() {
        thumb
            .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)
            .ok()?;
        "image/png"
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 80)
            .encode_image(&thumb.to_rgb8())
            .ok()?;
        "image/jpeg"
    };
    Some((
        width,
        height,
        format!("data:{mime};base64,{}", BASE64_STANDARD.encode(output)),
    ))
}

fn thumbnail_for(repo_dir: &Path, path: &str) -> Option<RepoThumbnail> {
    let is_svg = path.to_ascii_lowercase().ends_with(".svg");
    let cap = if is_svg {
        MAX_SVG_BYTES
    } else {
        MAX_PREVIEW_FILE_BYTES
    };
    let bytes = read_file_bytes(repo_dir, path, cap)?;
    let (width, height, data_url) = if is_svg {
        (
            0,
            0,
            format!(
                "data:image/svg+xml;base64,{}",
                BASE64_STANDARD.encode(bytes)
            ),
        )
    } else {
        raster_thumbnail(&bytes)?
    };
    Some(RepoThumbnail {
        path: path.to_string(),
        width,
        height,
        data_url,
    })
}

fn thumbnails_from(
    repo_dir: &Path,
    paths: &[String],
    mut emit: impl FnMut(RepoThumbnail),
) -> Vec<String> {
    let mut made = Vec::new();
    for path in paths {
        if validate_repo_file_path(path).is_err() {
            continue;
        }
        if let Some(thumbnail) = thumbnail_for(repo_dir, path) {
            made.push(thumbnail.path.clone());
            emit(thumbnail);
        }
    }
    made
}

fn sender(channel: Channel<RepoThumbnail>) -> impl FnMut(RepoThumbnail) {
    move |thumbnail| {
        let _ = channel.send(thumbnail);
    }
}

fn limited(mut paths: Vec<String>) -> Vec<String> {
    paths.truncate(MAX_THUMBNAIL_PATHS);
    paths
}

#[tauri::command]
pub async fn get_project_repo_thumbnails(
    clone_url: String,
    default_branch: Option<String>,
    target_ref: Option<String>,
    target_commit: Option<String>,
    paths: Vec<String>,
    on_thumbnail: Channel<RepoThumbnail>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    validate_workspace_clone_url(&clone_url, &state)?;
    let paths = limited(paths);
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let auth = build_git_auth_config(&state)?;
    let repo = RemoteRepo::new(clone_url, default_branch, target_ref, target_commit);

    tauri::async_runtime::spawn_blocking(move || {
        let repo_dir = app
            .state::<RepoClones>()
            .files(&repo, &paths, Freshness::Latest, &auth)?;
        Ok(thumbnails_from(&repo_dir, &paths, sender(on_thumbnail)))
    })
    .await
    .map_err(|error| format!("repo thumbnails task failed: {error}"))?
}

#[tauri::command]
pub async fn get_project_local_repo_thumbnails(
    repos_dir: Option<String>,
    project_dtag: String,
    clone_url: Option<String>,
    paths: Vec<String>,
    on_thumbnail: Channel<RepoThumbnail>,
) -> Result<Vec<String>, String> {
    let paths = limited(paths);
    tauri::async_runtime::spawn_blocking(move || {
        let repo_dir =
            find_local_repo_dir(repos_dir.as_deref(), &project_dtag, clone_url.as_deref())?;
        Ok(repo_dir
            .map(|dir| thumbnails_from(&dir, &paths, sender(on_thumbnail)))
            .unwrap_or_default())
    })
    .await
    .map_err(|error| format!("local repo thumbnails task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32, alpha: bool) -> Vec<u8> {
        let image = if alpha {
            image::DynamicImage::new_rgba8(width, height)
        } else {
            image::DynamicImage::new_rgb8(width, height)
        };
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn shrinks_rasters_and_keeps_their_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("wide.png"), png(1200, 600, false)).unwrap();
        std::fs::write(dir.path().join("clear.png"), png(10, 20, true)).unwrap();
        std::fs::write(dir.path().join("logo.svg"), "<svg/>").unwrap();
        std::fs::write(dir.path().join("broken.jpg"), [0xff, 0xd8, 0x00]).unwrap();

        let paths = [
            "wide.png",
            "clear.png",
            "logo.svg",
            "broken.jpg",
            "../x.png",
        ]
        .map(String::from)
        .to_vec();
        let mut thumbs = Vec::new();
        let made = thumbnails_from(dir.path(), &paths, |thumb| thumbs.push(thumb));
        assert_eq!(made, ["wide.png", "clear.png", "logo.svg"]);

        let found: Vec<_> = thumbs
            .iter()
            .map(|t| (t.path.as_str(), t.width, t.height))
            .collect();
        assert_eq!(
            found,
            [
                ("wide.png", 1200, 600),
                ("clear.png", 10, 20),
                ("logo.svg", 0, 0)
            ]
        );
        assert!(thumbs[0].data_url.starts_with("data:image/jpeg;base64,"));
        assert!(thumbs[1].data_url.starts_with("data:image/png;base64,"));
        assert!(thumbs[2].data_url.starts_with("data:image/svg+xml;base64,"));

        let encoded = thumbs[0].data_url.split(',').nth(1).unwrap();
        let thumb = image::load_from_memory(&BASE64_STANDARD.decode(encoded).unwrap()).unwrap();
        assert_eq!(
            (thumb.width(), thumb.height()),
            (THUMBNAIL_EDGE, THUMBNAIL_EDGE / 2)
        );
    }

    #[test]
    fn caps_the_number_of_paths() {
        let paths = (0..MAX_THUMBNAIL_PATHS + 5)
            .map(|i| format!("{i}.png"))
            .collect();
        assert_eq!(limited(paths).len(), MAX_THUMBNAIL_PATHS);
    }
}
