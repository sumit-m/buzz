//! LOCAL DIVERGENCE: reclaim the storage of uploads nothing uses any more.
//! Upstream keeps every blob forever.
//!
//! Two triggers, one primitive. A delete or channel clear hands over the
//! hashes its messages attached, reclaimed at once. A background task, its
//! first run one [`SWEEP_INTERVAL`] after startup, walks every community's
//! media sidecars (`_meta/<community>/<sha256>.json`, written for every
//! upload) and reclaims the unused ones older than [`SWEEP_GRACE`], so a file
//! uploaded for a message not yet sent survives. Upload records in the
//! database exist only when media access checks are on, so they can't be the
//! inventory.
//!
//! Per community, reclaiming drops the sidecar, the upload records and any
//! database claims; the shared bytes and thumbnails go only once no community
//! keeps a sidecar for the hash. Only keys of the media shapes are touched — a
//! bucket the git store shares holds nothing else under these prefixes.
//!
//! `BUZZ_MEDIA_GC`: `on` (default), `report` (log what would go, delete
//! nothing), or `off`.

use std::sync::Arc;
use std::time::Duration;

use buzz_core::CommunityId;
use buzz_media::bucket_index::{classify_key, KeyClass};
use buzz_media::{BlobMeta, MediaStorage};
use tracing::{info, warn};

use crate::state::AppState;

/// How old an unused upload must be before the sweep takes it.
pub const SWEEP_GRACE: Duration = Duration::from_secs(24 * 60 * 60);
/// How often the sweep walks every upload, the first time after one interval.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// One relay of several sweeps at a time.
const SWEEP_LOCK_KEY: i64 = 0x4255_5A5A_4D47_4331;
const LIST_PAGE: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    On,
    Report,
    Off,
}

fn mode() -> Mode {
    static MODE: std::sync::OnceLock<Mode> = std::sync::OnceLock::new();
    *MODE.get_or_init(|| {
        match std::env::var("BUZZ_MEDIA_GC")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "off" => Mode::Off,
            "report" => Mode::Report,
            _ => Mode::On,
        }
    })
}

/// Reclaim what a delete just stopped using, off the request path.
pub fn reclaim_after_delete(state: &Arc<AppState>, community: CommunityId, hashes: Vec<String>) {
    if hashes.is_empty() || mode() == Mode::Off {
        return;
    }
    let state = Arc::clone(state);
    tokio::spawn(async move {
        if let Err(e) = reclaim(&state, community, &hashes, None).await {
            warn!(error = %e, "media reclaim after delete failed");
        }
    });
}

/// The hourly sweep. Never runs at startup: the first pass waits one
/// [`SWEEP_INTERVAL`].
pub async fn run_sweeper(state: Arc<AppState>) {
    if mode() == Mode::Off {
        return;
    }
    let mut ticks =
        tokio::time::interval_at(tokio::time::Instant::now() + SWEEP_INTERVAL, SWEEP_INTERVAL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        let leader = match state.db.try_lock_session_leader(SWEEP_LOCK_KEY).await {
            Ok(Some(leader)) => leader,
            Ok(None) => continue,
            Err(e) => {
                warn!(error = %e, "media sweep could not take its lock");
                continue;
            }
        };
        let started = std::time::Instant::now();
        match sweep(&state).await {
            Ok(reclaimed) => info!(
                reclaimed,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "media sweep finished"
            ),
            Err(e) => warn!(error = %e, "media sweep failed"),
        }
        drop(leader);
    }
}

/// Walk every sidecar, a listing page at a time, community by community.
async fn sweep(state: &AppState) -> anyhow::Result<usize> {
    let cutoff = chrono::Utc::now().timestamp() - SWEEP_GRACE.as_secs() as i64;
    let mut reclaimed = 0;
    let mut token = None;
    loop {
        let page = state
            .media_storage
            .list_prefix_page("_meta/", token, LIST_PAGE)
            .await?;
        let mut sidecars: Vec<(CommunityId, String)> = page
            .objects
            .iter()
            .filter_map(|(key, _)| match classify_key(key) {
                KeyClass::Sidecar { community, sha256 } => {
                    Some((CommunityId::from_uuid(community), sha256))
                }
                _ => None,
            })
            .collect();
        sidecars.sort();
        for group in sidecars.chunk_by(|a, b| a.0 == b.0) {
            let community = group[0].0;
            let hashes: Vec<String> = group.iter().map(|(_, sha)| sha.clone()).collect();
            reclaimed += reclaim(state, community, &hashes, Some(cutoff)).await?;
        }
        match page.next_continuation_token {
            Some(next) if page.is_truncated => token = Some(next),
            _ => return Ok(reclaimed),
        }
    }
}

/// Reclaim each of `hashes` nothing in `community` uses, when uploaded at or
/// before `uploaded_by` (any age when `None`). Returns how many went.
async fn reclaim(
    state: &AppState,
    community: CommunityId,
    hashes: &[String],
    uploaded_by: Option<i64>,
) -> anyhow::Result<usize> {
    let storage = &state.media_storage;
    let mut reclaimed = 0;
    for sha in state.db.unused_media(community, hashes).await? {
        if let Some(cutoff) = uploaded_by {
            if uploaded_at(storage, community, &sha)
                .await
                .is_some_and(|at| at > cutoff)
            {
                continue;
            }
        }
        if mode() == Mode::Report {
            info!(community = %community, sha256 = %sha, "media unused (report only)");
            continue;
        }
        reclaim_one(state, community, &sha).await?;
        reclaimed += 1;
    }
    if reclaimed > 0 {
        info!(community = %community, reclaimed, "reclaimed unused media");
    }
    Ok(reclaimed)
}

async fn uploaded_at(storage: &MediaStorage, community: CommunityId, sha: &str) -> Option<i64> {
    let bytes = storage
        .get(&MediaStorage::sidecar_key(community, sha))
        .await
        .ok()?;
    serde_json::from_slice::<BlobMeta>(&bytes)
        .ok()
        .map(|meta| meta.uploaded_at)
}

async fn reclaim_one(state: &AppState, community: CommunityId, sha: &str) -> anyhow::Result<()> {
    let storage = &state.media_storage;
    let mut keys = list_keys(
        storage,
        &format!("_uploads/{community}/{sha}/"),
        |class| matches!(class, KeyClass::Auxiliary { sha256, .. } if sha256 == sha),
    )
    .await?;
    keys.push(MediaStorage::sidecar_key(community, sha));
    storage.delete_objects(&keys).await?;
    state.db.forget_media(community, sha).await?;

    for other in state.db.media_community_ids().await? {
        if other != community && storage.head(&MediaStorage::sidecar_key(other, sha)).await? {
            return Ok(());
        }
    }
    let bytes = list_keys(storage, &format!("{sha}."), |class| match class {
        KeyClass::Blob { sha256, .. } | KeyClass::Thumb { sha256 } => sha256 == sha,
        _ => false,
    })
    .await?;
    storage.delete_objects(&bytes).await?;
    Ok(())
}

async fn list_keys(
    storage: &MediaStorage,
    prefix: &str,
    wanted: impl Fn(&KeyClass) -> bool,
) -> anyhow::Result<Vec<String>> {
    let mut keys = Vec::new();
    let mut token = None;
    loop {
        let page = storage.list_prefix_page(prefix, token, LIST_PAGE).await?;
        keys.extend(
            page.objects
                .into_iter()
                .map(|(key, _)| key)
                .filter(|key| wanted(&classify_key(key))),
        );
        match page.next_continuation_token {
            Some(next) if page.is_truncated => token = Some(next),
            _ => return Ok(keys),
        }
    }
}
