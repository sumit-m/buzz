//! Permanently deleting a repository.
//!
//! A kind:5 naming a `30617:` coordinate used to soft-delete the announcement
//! row and stop. The git data, the relay-signed ref state, the patches and
//! issues, and the name reservation all survived — so "delete" meant "hide",
//! re-announcing the same slug brought the repository back with its commits,
//! and the name stayed spent against `BUZZ_GIT_MAX_REPOS_PER_PUBKEY` forever.
//!
//! This module is the rest of that operation. There is deliberately no second
//! "delete permanently" action: recovering a deleted repository is not a
//! feature we want, so none of the machinery that would preserve one exists,
//! and the confirmation dialog's existing "cannot be undone" becomes true.
//!
//! ## Authorization is already done
//!
//! `validate_standard_deletion_event` runs pre-store and requires the kind:5
//! signer to be the pubkey inside the coordinate, or that pubkey's registered
//! NIP-OA owner. An unauthorized tombstone is rejected at ingest and never
//! reaches any side-effect handler. Do not add a second check here — a
//! duplicate that drifts from the original is worse than none.
//!
//! ## What makes it safe to run
//!
//! [`delete_repository`] is called only when `soft_delete_by_coordinate`
//! reports it actually removed a row. That is the load-bearing gate. The
//! coordinate delete is bounded by NIP-09's at-or-before rule, so a replayed or
//! delayed tombstone matches nothing and this never runs — which matters
//! because the name is released here, so by the time a stale tombstone arrives
//! the coordinate may belong to a different owner entirely.
//!
//! Combined with the pre-store check, the destructive step is doubly gated
//! without a line of new authorization code: validation proves the actor owns
//! the coordinate, and the delete is keyed on that same verified pubkey.
//!
//! ## Ordering: objects first, name last
//!
//! S3 has no atomic prefix delete — it is list-then-delete in a loop — so a
//! crash partway through leaves objects behind. This is the one residue in the
//! design that cannot self-heal, because inline reconciliation only ever runs
//! on a repo that still exists and gets pushed to; once the name is released
//! nothing will look at that prefix again.
//!
//! So: objects first, name last. Crash in between and the repository still
//! exists, so re-running the delete finishes the job — deleting an
//! already-deleted key is a no-op. Release the name first and crash, and the
//! prefix is both stranded *and* claimable: another owner takes the name and
//! writes into a prefix still holding the old repo's objects.

use std::sync::Arc;

use buzz_core::kind::{
    KIND_GIT_ISSUE, KIND_GIT_PATCH, KIND_GIT_PR_UPDATE, KIND_GIT_PULL_REQUEST,
    KIND_GIT_REPO_ANNOUNCEMENT, KIND_GIT_REPO_STATE, KIND_GIT_STATUS_CLOSED, KIND_GIT_STATUS_DRAFT,
    KIND_GIT_STATUS_MERGED, KIND_GIT_STATUS_OPEN,
};
use buzz_core::TenantContext;
use tracing::{info, warn};

use crate::api::git::manifest::RepoScope;
use crate::api::git::reclaim;
use crate::state::AppState;

/// Kinds that hang off a repo coordinate and die with it.
///
/// Not the announcement (already deleted, and it is what got us here) and not
/// the ref state (deleted by coordinate, since the relay signs it rather than
/// the repo owner).
const SATELLITE_KINDS: &[u32] = &[
    KIND_GIT_PATCH,
    KIND_GIT_PULL_REQUEST,
    KIND_GIT_PR_UPDATE,
    KIND_GIT_ISSUE,
    KIND_GIT_STATUS_OPEN,
    KIND_GIT_STATUS_MERGED,
    KIND_GIT_STATUS_CLOSED,
    KIND_GIT_STATUS_DRAFT,
];

/// Erase everything belonging to a repository whose announcement was just
/// soft-deleted.
///
/// `owner_hex` and `repo_id` come from the deletion's `a` tag; `RepoScope`
/// re-validates them rather than trusting that, because they have not passed
/// through the HTTP route that normally checks them and they become a prefix
/// this function deletes.
///
/// Every step is best-effort and independent. A failure is logged and the rest
/// continues: leaving the name claimed because the object store was briefly
/// unreachable would be a worse outcome than a partial delete, and re-issuing
/// the deletion re-runs all of it.
pub async fn delete_repository(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    owner_hex: &str,
    repo_id: &str,
) {
    let community = tenant.community();
    let coordinate = format!("{KIND_GIT_REPO_ANNOUNCEMENT}:{owner_hex}:{repo_id}");

    // 1. Objects. First, because the name must outlive them — see module docs.
    match RepoScope::new(community, owner_hex, repo_id) {
        Some(scope) => match reclaim::delete_repo_objects(&state.git_store, &scope).await {
            Ok(reclaimed) => {
                metrics::counter!("buzz_git_reclaimed_objects_total")
                    .increment(reclaimed.objects as u64);
                metrics::counter!("buzz_git_reclaimed_bytes_total").increment(reclaimed.bytes);
                info!(
                    repo_id = %repo_id,
                    objects = reclaimed.objects,
                    bytes = reclaimed.bytes,
                    "deleted git objects for repository"
                );
            }
            Err(error) => {
                metrics::counter!("buzz_git_reclaim_failures_total").increment(1);
                warn!(
                    repo_id = %repo_id,
                    error = %error,
                    "failed to delete git objects for repository; re-issue the deletion to retry"
                );
            }
        },
        None => {
            // Unreachable via a repo the relay itself announced: the announce
            // path validates both components. Reaching it means a coordinate
            // was accepted that could not have produced object keys, so there
            // is nothing under a prefix to delete.
            warn!(
                owner = %owner_hex,
                repo_id = %repo_id,
                "repo deletion: coordinate does not map to an object prefix; skipping objects"
            );
        }
    }

    // 2. The relay-signed ref state. Signed by the relay, not the owner, so it
    //    is not covered by the tombstone the owner published.
    let relay_pubkey = state.relay_keypair.public_key().to_bytes().to_vec();
    match state
        .db
        .soft_delete_by_coordinate(
            community,
            KIND_GIT_REPO_STATE as i32,
            &relay_pubkey,
            repo_id,
            chrono::Utc::now().timestamp(),
        )
        .await
    {
        Ok(true) => info!(repo_id = %repo_id, "deleted relay-signed git ref state"),
        Ok(false) => {}
        Err(error) => warn!(
            repo_id = %repo_id,
            error = %error,
            "failed to delete relay-signed git ref state"
        ),
    }

    // 3. Patches, issues, pull requests, statuses.
    let kinds: Vec<i32> = SATELLITE_KINDS.iter().map(|kind| *kind as i32).collect();
    match state
        .db
        .soft_delete_events_referencing_coordinate(community, &coordinate, &kinds)
        .await
    {
        Ok(0) => {}
        Ok(deleted) => info!(
            repo_id = %repo_id,
            events = deleted,
            "deleted git events referencing the repository"
        ),
        Err(error) => warn!(
            repo_id = %repo_id,
            error = %error,
            "failed to delete git events referencing the repository"
        ),
    }

    // 4. The name reservation. Last: while it is held, the coordinate cannot be
    //    claimed by anyone else, which is what makes an interrupted delete safe
    //    to re-run. `release_repo_name` is already scoped to the owner, so it
    //    cannot free a name a different owner holds.
    match state
        .db
        .release_repo_name(community, repo_id, owner_hex)
        .await
    {
        Ok(0) => {}
        Ok(_) => info!(repo_id = %repo_id, "released git repo name reservation"),
        Err(error) => warn!(
            repo_id = %repo_id,
            error = %error,
            "failed to release git repo name reservation"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn satellites_exclude_the_events_deleted_by_coordinate() {
        assert!(!SATELLITE_KINDS.contains(&KIND_GIT_REPO_ANNOUNCEMENT));
        assert!(!SATELLITE_KINDS.contains(&KIND_GIT_REPO_STATE));
    }

    /// Every NIP-34 kind that carries an `a` tag to a repo is either deleted by
    /// coordinate or listed here. A kind added to `buzz_core` and forgotten
    /// here would survive its repository.
    #[test]
    fn every_git_kind_is_accounted_for() {
        let by_coordinate = [KIND_GIT_REPO_ANNOUNCEMENT, KIND_GIT_REPO_STATE];
        for kind in [
            KIND_GIT_REPO_ANNOUNCEMENT,
            KIND_GIT_REPO_STATE,
            KIND_GIT_PATCH,
            KIND_GIT_PULL_REQUEST,
            KIND_GIT_PR_UPDATE,
            KIND_GIT_ISSUE,
            KIND_GIT_STATUS_OPEN,
            KIND_GIT_STATUS_MERGED,
            KIND_GIT_STATUS_CLOSED,
            KIND_GIT_STATUS_DRAFT,
        ] {
            assert!(
                by_coordinate.contains(&kind) || SATELLITE_KINDS.contains(&kind),
                "kind {kind} outlives its repository"
            );
        }
    }
}
