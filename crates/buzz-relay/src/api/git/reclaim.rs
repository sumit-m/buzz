//! Freeing a repository's object-store bytes.
//!
//! Two callers, one primitive. Compaction reconciles a repo's prefix down to
//! the manifest it just published; deletion removes the prefix outright. Both
//! are possible only because every object a repo owns lives under
//! [`RepoScope`] — see its docs for why that layout was chosen.
//!
//! ## Reconciliation, not diff deletion
//!
//! The step is defined as "delete what `m_after` does not name", not "delete
//! what `m_before` named and `m_after` does not". The difference is that
//! reconciliation is *self-healing*: a delete that fails, a process that dies
//! mid-loop, or garbage left by an older relay version is all picked up by the
//! next run. A diff would leave every one of those behind permanently.
//!
//! ## What makes it safe
//!
//! 1. **The listing is the repo's own prefix.** Nothing outside it is ever
//!    enumerated, and [`plan_reclamation`] re-asserts containment per key
//!    before the key reaches a delete. Belt and braces, because the failure
//!    mode is deleting another repo's data — or, on a deployment that has not
//!    set `BUZZ_GIT_S3_BUCKET`, somebody's uploaded media.
//! 2. **The live set is the manifest we just published**, not one read
//!    earlier. Reading it earlier admits the ordering where a concurrent push
//!    publishes between the read and the delete and we remove *its* packs.
//! 3. **A modification-time floor.** An object written recently is spared even
//!    if no live manifest names it, which covers the push that is uploading
//!    right now and has not yet reached its CAS. The floor carries a slack
//!    margin because the timestamps come from the object store's clock, not
//!    ours.
//! 4. **Content addressing means a survivor is never wrong.** Anything spared
//!    is retried by the next reconciliation, so erring towards keeping costs
//!    only bytes, and briefly.

use std::collections::BTreeSet;

use chrono::{DateTime, Duration, Utc};

use super::manifest::{Manifest, RepoScope};
use super::store::{GitStore, StoredObject};

/// Upper bound on objects enumerated under one repo prefix.
///
/// Reclamation runs inline on a push, so an unbounded listing would be an
/// unbounded stall. A repo over this is not reconciled — it is not corrupt,
/// just skipped, and it is far past anything the pack limits allow.
const MAX_REPO_OBJECTS: usize = 100_000;

/// How far back from "now" the modification-time floor sits.
///
/// `LastModified` is the object store's clock. If it runs behind ours, an
/// object written moments ago can look older than this push began, and a
/// concurrent push's pack would be eligible for deletion before its CAS lands.
/// The margin is the tolerance for that skew; the cost of it being generous is
/// that recent garbage waits for the next compaction, ~96 pushes away.
const CLOCK_SKEW_MARGIN_MINUTES: i64 = 15;

/// What one reclamation freed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reclaimed {
    /// Objects deleted.
    pub objects: usize,
    /// Bytes deleted, as the listing reported them.
    pub bytes: u64,
}

/// Every key that must survive a reconciliation against `manifest`.
///
/// The pointer is included even though it is not content-addressed: it is the
/// one mutable key a repo has, and deleting it would un-announce the repo.
fn live_keys(scope: &RepoScope, manifest: &Manifest, manifest_key: &str) -> BTreeSet<String> {
    let mut live = BTreeSet::new();
    live.insert(scope.pointer_key());
    live.insert(manifest_key.to_string());
    for pack_key in &manifest.packs {
        live.insert(pack_key.clone());
        if let Ok(idx_key) = GitStore::idx_key_for_pack_key(pack_key) {
            live.insert(idx_key);
        }
    }
    live
}

/// Decide which listed objects to delete.
///
/// Split out from the I/O so the decision is testable without an object store,
/// which matters more here than anywhere else in the git path: every bug in
/// this function destroys data.
///
/// Superseded manifests are deleted. `Manifest::parent` is a digest recorded
/// for lineage and is never fetched — the read path resolves pointer → current
/// manifest and stops — so an unreachable manifest is genuinely unreachable.
fn plan_reclamation<'a>(
    scope: &RepoScope,
    live: &BTreeSet<String>,
    listed: &'a [StoredObject],
    modified_before: DateTime<Utc>,
) -> Vec<&'a StoredObject> {
    listed
        .iter()
        .filter(|object| {
            scope.contains(&object.key)
                && !live.contains(&object.key)
                && object
                    .last_modified
                    .is_some_and(|modified| modified < modified_before)
        })
        .collect()
}

/// Delete everything in `scope` that `manifest` does not name.
///
/// Call this only after the pointer CAS has been won with `manifest`, and pass
/// the key it was published under. `push_started_at` is the instant before this
/// push wrote anything, which together with the skew margin forms the
/// modification-time floor.
///
/// Errors are the caller's to swallow: reclamation is an optimisation, and a
/// push that has already committed must not be reported as failed because a
/// cleanup could not finish. It will be retried by the next compaction.
pub async fn reconcile_to_manifest(
    store: &GitStore,
    scope: &RepoScope,
    manifest: &Manifest,
    manifest_key: &str,
    push_started_at: DateTime<Utc>,
) -> Result<Reclaimed, super::store::StoreError> {
    let listed = store
        .list_prefix(&scope.key_prefix(), MAX_REPO_OBJECTS)
        .await?;
    let live = live_keys(scope, manifest, manifest_key);
    let floor = push_started_at - Duration::minutes(CLOCK_SKEW_MARGIN_MINUTES);
    let doomed = plan_reclamation(scope, &live, &listed, floor);

    let mut reclaimed = Reclaimed::default();
    for object in doomed {
        store.delete_object(&object.key).await?;
        reclaimed.objects += 1;
        reclaimed.bytes = reclaimed.bytes.saturating_add(object.size);
    }
    Ok(reclaimed)
}

/// Delete every object the repo owns.
///
/// No live set and no time floor: the caller has established that the
/// repository is gone, so there is nothing left to protect. Deleting an
/// already-deleted key is a no-op, which is what makes a partially completed
/// delete safe to re-run.
pub async fn delete_repo_objects(
    store: &GitStore,
    scope: &RepoScope,
) -> Result<Reclaimed, super::store::StoreError> {
    let listed = store
        .list_prefix(&scope.key_prefix(), MAX_REPO_OBJECTS)
        .await?;
    let mut reclaimed = Reclaimed::default();
    for object in listed {
        if !scope.contains(&object.key) {
            continue;
        }
        store.delete_object(&object.key).await?;
        reclaimed.objects += 1;
        reclaimed.bytes = reclaimed.bytes.saturating_add(object.size);
    }
    Ok(reclaimed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn scope() -> RepoScope {
        RepoScope::new(
            buzz_core::CommunityId::from_uuid(uuid::Uuid::from_u128(7)),
            &"a".repeat(64),
            "repo",
        )
        .expect("valid scope")
    }

    fn other_scope() -> RepoScope {
        RepoScope::new(
            buzz_core::CommunityId::from_uuid(uuid::Uuid::from_u128(7)),
            &"b".repeat(64),
            "repo",
        )
        .expect("valid scope")
    }

    fn digest(ch: char) -> String {
        std::iter::repeat_n(ch, 64).collect()
    }

    fn object(key: &str, age_minutes: i64) -> StoredObject {
        StoredObject {
            key: key.to_string(),
            size: 10,
            last_modified: Some(now() - Duration::minutes(age_minutes)),
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::from_timestamp(1_700_000_000, 0).expect("valid timestamp")
    }

    fn manifest_with(scope: &RepoScope, packs: &[char]) -> Manifest {
        Manifest {
            version: super::super::manifest::MANIFEST_VERSION,
            head: "refs/heads/main".into(),
            refs: BTreeMap::from([("refs/heads/main".to_string(), "a".repeat(40))]),
            packs: packs
                .iter()
                .map(|ch| format!("{}/{}", scope.packs_prefix(), digest(*ch)))
                .collect(),
            parent: None,
            published_at: None,
        }
    }

    fn plan_keys(objects: &[StoredObject], live: &BTreeSet<String>) -> Vec<String> {
        plan_reclamation(&scope(), live, objects, now())
            .into_iter()
            .map(|object| object.key.clone())
            .collect()
    }

    #[test]
    fn live_set_covers_the_pointer_the_manifest_and_every_pack_with_its_idx() {
        let scope = scope();
        let manifest = manifest_with(&scope, &['1', '2']);
        let manifest_key = format!("{}/{}", scope.manifests_prefix(), digest('9'));
        let live = live_keys(&scope, &manifest, &manifest_key);

        assert!(live.contains(&scope.pointer_key()));
        assert!(live.contains(&manifest_key));
        for ch in ['1', '2'] {
            assert!(live.contains(&format!("{}/{}", scope.packs_prefix(), digest(ch))));
            assert!(live.contains(&format!("{}/idx/{}", scope.prefix(), digest(ch))));
        }
    }

    #[test]
    fn compaction_garbage_is_reclaimed_and_the_new_pack_set_is_not() {
        let scope = scope();
        let manifest = manifest_with(&scope, &['1']);
        let manifest_key = format!("{}/{}", scope.manifests_prefix(), digest('9'));
        let live = live_keys(&scope, &manifest, &manifest_key);

        let objects = vec![
            object(&scope.pointer_key(), 60),
            object(&manifest_key, 60),
            object(&format!("{}/{}", scope.packs_prefix(), digest('1')), 60),
            object(&format!("{}/idx/{}", scope.prefix(), digest('1')), 60),
            // The pack set the compaction replaced, and its superseded manifest.
            object(&format!("{}/{}", scope.packs_prefix(), digest('7')), 60),
            object(&format!("{}/idx/{}", scope.prefix(), digest('7')), 60),
            object(&format!("{}/{}", scope.manifests_prefix(), digest('8')), 60),
        ];

        assert_eq!(
            plan_keys(&objects, &live),
            vec![
                format!("{}/{}", scope.packs_prefix(), digest('7')),
                format!("{}/idx/{}", scope.prefix(), digest('7')),
                format!("{}/{}", scope.manifests_prefix(), digest('8')),
            ]
        );
    }

    /// The ordering this guards: a concurrent push uploads a pack, we win the
    /// CAS first, and our reconciliation runs before that push reaches its own
    /// CAS. Its pack is not in our manifest and must still survive.
    #[test]
    fn an_object_written_after_the_floor_is_spared() {
        let scope = scope();
        let manifest = manifest_with(&scope, &['1']);
        let manifest_key = format!("{}/{}", scope.manifests_prefix(), digest('9'));
        let live = live_keys(&scope, &manifest, &manifest_key);

        let concurrent = format!("{}/{}", scope.packs_prefix(), digest('5'));
        let objects = vec![object(&concurrent, -1)];
        assert!(plan_keys(&objects, &live).is_empty());
    }

    /// A backend whose timestamp we could not parse is treated as too recent
    /// to touch, so an unparseable listing degrades to reclaiming nothing
    /// rather than to reclaiming everything.
    #[test]
    fn an_object_with_no_timestamp_is_spared() {
        let scope = scope();
        let manifest = manifest_with(&scope, &['1']);
        let manifest_key = format!("{}/{}", scope.manifests_prefix(), digest('9'));
        let live = live_keys(&scope, &manifest, &manifest_key);

        let objects = vec![StoredObject {
            key: format!("{}/{}", scope.packs_prefix(), digest('5')),
            size: 10,
            last_modified: None,
        }];
        assert!(plan_keys(&objects, &live).is_empty());
    }

    /// The listing is prefix-scoped, so this should be unreachable. It is
    /// asserted anyway because the cost of the assertion is nothing and the
    /// cost of it being needed and absent is another repo's data.
    #[test]
    fn a_key_outside_the_scope_is_never_planned_for_deletion() {
        let scope = scope();
        let manifest = manifest_with(&scope, &['1']);
        let manifest_key = format!("{}/{}", scope.manifests_prefix(), digest('9'));
        let live = live_keys(&scope, &manifest, &manifest_key);

        let objects = vec![
            object(
                &format!("{}/{}", other_scope().packs_prefix(), digest('3')),
                60,
            ),
            object("media/some-blossom-hash", 60),
            object(&format!("packs/{}", digest('4')), 60),
        ];
        assert!(plan_keys(&objects, &live).is_empty());
    }

    /// A repo pushed to before namespacing has live packs under the global
    /// prefix. Those are outside its scope, so reconciliation cannot reach
    /// them — which is the correct outcome, since it also cannot prove no
    /// other repo shares them.
    #[test]
    fn packs_from_before_namespacing_are_left_alone() {
        let scope = scope();
        let mut manifest = manifest_with(&scope, &['1']);
        manifest.packs.push(format!("packs/{}", digest('2')));
        let manifest_key = format!("{}/{}", scope.manifests_prefix(), digest('9'));
        let live = live_keys(&scope, &manifest, &manifest_key);

        assert!(live.contains(&format!("packs/{}", digest('2'))));
        assert!(live.contains(&format!("idx/{}", digest('2'))));
    }
}
