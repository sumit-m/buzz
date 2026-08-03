//! Manifest schema for git-on-object-storage.
//!
//! The manifest is the immutable, content-addressed snapshot of a repo's
//! published state at a single point in time (§System Model). A push commits
//! by CAS-installing a new pointer to a new manifest digest; readers resolve
//! pointer → manifest → packs to hydrate (§Read).
//!
//! ## Canonical serialization
//!
//! `Manifest::canonical_bytes()` produces a deterministic byte sequence so
//! that `key == sha256(bytes)` (A1 detectability):
//!
//! - `refs: BTreeMap` — sorted ref names at serialization.
//! - `packs: Vec<String>` — sorted by `canonical_bytes()` before writing.
//! - Struct field order: `version`, `head`, `refs`, `packs`, `parent`,
//!   `published_at` (matches declaration; serde emits in this order, and
//!   omits `published_at` when absent).
//! - `serde_json::to_vec` — no whitespace.
//!
//! Round-trip + byte-stability are pinned in unit tests.
//!
//! ## Why HEAD is in the manifest
//!
//! HEAD is *published* ref state (§Implementation Correspondence), not a
//! read-time default. Deriving it ("default to main, fallback to first head")
//! would let a clone advertise a different default branch than the writer
//! intended — `Inv_RefEffectApplied` would not hold.

use std::collections::BTreeMap;

use buzz_core::tenant::CommunityId;
use serde::{Deserialize, Serialize};

/// Current manifest schema version. Bump on incompatible change.
pub const MANIFEST_VERSION: u32 = 1;
/// Maximum number of pack objects one manifest may reference.
///
/// Hydration indexes packs one at a time, but an unbounded pack list still
/// turns one request into unbounded object-store and git subprocess work.
pub const MAX_MANIFEST_PACKS: usize = 128;
/// Pack count that triggers proactive consolidation during the next accepted push.
///
/// Keeping one quarter of the manifest capacity in reserve prevents a hot
/// repository from reaching the hard limit while a prior compaction attempt
/// falls back to the normal delta-pack path.
pub const PACK_COMPACTION_THRESHOLD: usize = MAX_MANIFEST_PACKS * 3 / 4;
/// Maximum number of refs one manifest may advertise.
pub const MAX_MANIFEST_REFS: usize = 10_000;

/// A repository's published state.
///
/// Field order is significant for canonical JSON — do not reorder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// Schema version. Must equal [`MANIFEST_VERSION`] on read.
    pub version: u32,
    /// Symbolic HEAD ref, unprefixed (e.g. `"refs/heads/main"`). No `"ref: "`
    /// — that's a Git-protocol formatting concern, applied at hydrate time.
    pub head: String,
    /// All refs in the published state: refname → 40-char hex oid.
    pub refs: BTreeMap<String, String>,
    /// Store keys of every pack covering `refs`. Sorted ascending —
    /// `canonical_bytes` enforces this on serialize.
    pub packs: Vec<String>,
    /// **Bare hex digest** of the manifest this one supersedes (64 chars,
    /// SHA-256), or `None` for the first push to a fresh repo. Contrast with
    /// `packs` which carries full store keys (`packs/<hex>`); `parent` is the
    /// digest alone, matching the pointer-body shape so `Inv_RefDerivedFromParent`
    /// reads literally as `parent = pointer.digest`. Writers must strip any
    /// `manifests/` prefix before assigning. Enforced by `validate()`.
    pub parent: Option<String>,
    /// Unix seconds at which a push published this manifest, strictly greater
    /// than the parent's. The derived kind:30618 carries it as `created_at`,
    /// so readers that pick the newest event follow the manifest chain rather
    /// than the order in which relay instances happened to stamp events.
    /// `None` for the shared announce-time seed and for manifests written
    /// before the field existed; omitted from canonical JSON in that case so
    /// those manifests keep their bytes and digests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<u64>,
}

/// The `published_at` for a manifest superseding `parent`: `now`, advanced
/// past the parent's own `published_at` when the clock has not moved on (two
/// pushes in one second) or runs behind the instance that wrote the parent.
///
/// An unstamped parent (the announce-time seed, or a manifest written before
/// the field existed) had its kind:30618 stamped at or before `now`, possibly
/// in this same second, so the successor takes `now + 1` to sort after it.
pub fn next_published_at(parent: &Manifest, now: u64) -> u64 {
    match parent.published_at {
        Some(previous) => now.max(previous.saturating_add(1)),
        None => now.saturating_add(1),
    }
}

/// Errors from manifest (de)serialization or validation.
#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    /// `serde_json` failed to encode or decode.
    #[error("manifest serde: {0}")]
    Serde(#[from] serde_json::Error),
    /// On-the-wire manifest carried a `version` we don't understand.
    #[error("unsupported manifest version {got} (expected {expected})")]
    UnsupportedVersion {
        /// The version we read.
        got: u32,
        /// The version we support.
        expected: u32,
    },
    /// A refname in `refs` (or `head`) violates `is_safe_refname` — must start
    /// with `refs/`, no traversal, no control chars. Symmetric write-side check
    /// for the reader-side validation in `api::git::hydrate`.
    #[error("manifest contains unsafe ref name {0:?}")]
    UnsafeRefName(String),
    /// An object id in `refs` is not a valid hex SHA-1 (40) or SHA-256 (64).
    #[error("manifest ref {refname:?} has malformed oid {oid:?}")]
    MalformedOid {
        /// The ref carrying the bad oid.
        refname: String,
        /// The oid that failed validation.
        oid: String,
    },
    /// Manifest `head` is empty — pre-CAS validation must reject this so we
    /// never commit an un-clone-able manifest (read side `is_safe_refname("")`
    /// returns false).
    #[error("manifest head is empty")]
    EmptyHead,
    /// `parent` is not a bare 64-char hex digest. Common mistake: storing the
    /// full store key (`manifests/<hex>`) instead of stripping the prefix.
    /// Breaks the "manifest.parent == pointer.digest" model invariant
    /// (`Inv_RefDerivedFromParent`).
    #[error("manifest parent is not a bare 64-char hex digest: {0:?}")]
    MalformedParent(String),
    /// Manifest names too many packs for one bounded hydration request.
    #[error("manifest contains too many packs: {got} (max {max})")]
    TooManyPacks {
        /// Number of pack keys in the manifest.
        got: usize,
        /// Hard cap enforced by the relay.
        max: usize,
    },
    /// Manifest names too many refs for one bounded advertisement request.
    #[error("manifest contains too many refs: {got} (max {max})")]
    TooManyRefs {
        /// Number of refs in the manifest.
        got: usize,
        /// Hard cap enforced by the relay.
        max: usize,
    },
    /// A pack key is not exactly `packs/<64 lowercase hex sha256>`.
    #[error("manifest contains malformed pack key {0:?}")]
    MalformedPackKey(String),
}

/// Conservative refname validation, used symmetrically on both the write side
/// (in `Manifest::validate`, before `put_manifest`) and the read side (in
/// `api::git::hydrate`, before writing the ref to disk).
///
/// Refuses traversal (`..`), null/newline/control chars, non-`refs/` prefixes,
/// and leading/trailing/double slashes. Allowed alphabet:
/// `[a-zA-Z0-9_./-]`.
///
/// Sharing one predicate is load-bearing: any divergence creates the
/// "valid CAS, un-clone-able output" hazard.
pub fn is_safe_refname(s: &str) -> bool {
    if !s.starts_with("refs/") {
        return false;
    }
    if s.contains("..") || s.contains("//") || s.starts_with('/') || s.ends_with('/') {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-'))
}

/// Hex-OID predicate. Accepts both SHA-1 (40 chars) and SHA-256 (64 chars) —
/// buzz pins SHA-1 today but the predicate is forward-looking. Used
/// symmetrically by write-side validation and read-side hydration.
pub fn is_hex_oid(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Bare manifest-digest predicate (64-char hex SHA-256).
///
/// Distinct from `is_hex_oid` (which also accepts 40-char SHA-1 for ref OIDs):
/// manifest digests are *always* SHA-256, so this is the tighter predicate
/// for the `Manifest::parent` field.
fn is_manifest_digest(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// Content-addressed pack-key predicate.
///
/// Accepts both layouts. New writes land under a repo's own namespace
/// (`repos/<community>/<owner>/<repo>/packs/<digest>`); manifests written
/// before that change name global `packs/<digest>` keys and must keep
/// resolving, since `Manifest.packs` stores full store keys and nothing
/// rewrites them.
pub fn is_pack_key(s: &str) -> bool {
    let Some((dir, digest)) = s.rsplit_once('/') else {
        return false;
    };
    is_manifest_digest(digest) && (dir == "packs" || is_repo_scoped_dir(dir, "packs"))
}

/// The bare digest of a manifest key, under either layout.
///
/// Pointers and `Manifest::parent` store the bare digest, so every writer that
/// has just produced a manifest key needs this to get back to it. Returns
/// `None` for anything that is not a manifest key.
pub fn digest_of_manifest_key(key: &str) -> Option<&str> {
    let (dir, digest) = key.rsplit_once('/')?;
    if !is_manifest_digest(digest) {
        return None;
    }
    (dir == "manifests" || is_repo_scoped_dir(dir, "manifests")).then_some(digest)
}

/// True when `dir` is `repos/<community>/<owner>/<repo>/<leaf>` with no empty
/// or dot segments.
fn is_repo_scoped_dir(dir: &str, leaf: &str) -> bool {
    let Some(rest) = dir.strip_prefix("repos/") else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(leaf) else {
        return false;
    };
    let Some(rest) = rest.strip_suffix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    segments.len() == 3
        && segments
            .iter()
            .all(|s| !s.is_empty() && *s != "." && *s != "..")
}

/// The canonical pointer key for a repo: `repos/<community>/<owner>/<repo>/pointer`.
///
/// Single source of truth shared by `cas_publish` (write side) and `hydrate`
/// (read side). Strips a trailing `.git` if the caller passed it. The
/// `repos/<community>/<owner>/<repo>/` namespace keeps the existing repo-local
/// subtree intact under the server-resolved community boundary, while shared
/// pack/manifest CAS objects remain outside that scoped pointer namespace.
pub fn pointer_key(community: CommunityId, owner: &str, repo: &str) -> String {
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    format!("repos/{community}/{owner}/{repo}/pointer")
}

/// Every object one repository owns, under a single prefix.
///
/// Packs and manifests used to be keyed globally (`packs/<digest>`), which made
/// them shared between repos and therefore impossible to free without proving
/// no other repo referenced them. Scoping them per repo trades cross-repo
/// dedup — worth little, since independent `pack-objects` runs rarely produce
/// identical bytes — for two properties that are worth a great deal: deleting a
/// repository is a prefix delete, and reclaiming a repository's garbage needs
/// only the manifest that repository just published.
///
/// Keys stay content-addressed within the prefix, so `put_immutable`'s
/// "412 means the key already holds exactly these bytes" argument is unchanged
/// and idempotent retries still collapse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoScope {
    prefix: String,
}

/// Owner must be a 64-char lowercase-hex pubkey.
///
/// Mirrors `transport::validate_repo_id`, which guards the push and clone
/// paths. `RepoScope` re-checks rather than trusting its caller because the
/// deletion path derives owner and repo from an event's `a` tag, which no HTTP
/// route has validated, and turns them into a prefix it then deletes.
fn is_owner_pubkey(owner: &str) -> bool {
    owner.len() == 64
        && owner
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn is_repo_component(repo: &str) -> bool {
    !repo.is_empty()
        && repo.len() <= 64
        && !repo.starts_with('.')
        && !repo.contains("..")
        && repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

impl RepoScope {
    /// Returns `None` when owner or repo would not survive
    /// `transport::validate_repo_id` — i.e. when the caller cannot be trusted
    /// to have produced a key that stays inside the intended namespace.
    pub fn new(community: CommunityId, owner: &str, repo: &str) -> Option<Self> {
        let repo = repo.strip_suffix(".git").unwrap_or(repo);
        if !is_owner_pubkey(owner) || !is_repo_component(repo) {
            return None;
        }
        Some(Self {
            prefix: format!("repos/{community}/{owner}/{repo}"),
        })
    }

    /// `repos/<community>/<owner>/<repo>` — no trailing slash.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The prefix every key this repo owns starts with, slash included.
    ///
    /// Use this and not [`prefix`](Self::prefix) for containment checks and
    /// for listing: without the slash, `…/repo` also matches `…/repo-2`.
    pub fn key_prefix(&self) -> String {
        format!("{}/", self.prefix)
    }

    /// `<prefix>/pointer` — the one mutable key a repo has.
    pub fn pointer_key(&self) -> String {
        format!("{}/pointer", self.prefix)
    }

    /// Prefix for this repo's pack objects.
    pub fn packs_prefix(&self) -> String {
        format!("{}/packs", self.prefix)
    }

    /// Prefix for this repo's manifest objects.
    pub fn manifests_prefix(&self) -> String {
        format!("{}/manifests", self.prefix)
    }

    /// True when `key` is one this repo owns.
    pub fn contains(&self, key: &str) -> bool {
        key.starts_with(&self.key_prefix())
    }
}

impl Manifest {
    /// Validate pre-commit invariants.
    ///
    /// **Writers must call this before `canonical_bytes` → `put_manifest`.**
    /// A manifest that hydrators reject (unsafe refname, malformed oid, empty
    /// HEAD) MUST NOT be written: it would CAS successfully and then 5xx every
    /// subsequent clone — "valid CAS, un-clone-able output". Pre-CAS rejection
    /// turns those into push-time 4xx, which is the right surface for the bug.
    ///
    /// Checks:
    /// - `head` is non-empty and passes `is_safe_refname`.
    /// - Every key in `refs` passes `is_safe_refname`.
    /// - Every value in `refs` is a hex OID per `is_hex_oid`.
    /// - Pack/ref cardinality stays within bounded hydration limits.
    /// - Every pack key is a canonical content-addressed key.
    /// - `parent`, if `Some`, is a bare 64-char hex digest (not a store key).
    ///
    /// Read-side `hydrate` runs the same predicates as defense-in-depth.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.packs.len() > MAX_MANIFEST_PACKS {
            return Err(ManifestError::TooManyPacks {
                got: self.packs.len(),
                max: MAX_MANIFEST_PACKS,
            });
        }
        if self.refs.len() > MAX_MANIFEST_REFS {
            return Err(ManifestError::TooManyRefs {
                got: self.refs.len(),
                max: MAX_MANIFEST_REFS,
            });
        }
        if self.head.is_empty() {
            return Err(ManifestError::EmptyHead);
        }
        if !is_safe_refname(&self.head) {
            return Err(ManifestError::UnsafeRefName(self.head.clone()));
        }
        for (refname, oid) in &self.refs {
            if !is_safe_refname(refname) {
                return Err(ManifestError::UnsafeRefName(refname.clone()));
            }
            if !is_hex_oid(oid) {
                return Err(ManifestError::MalformedOid {
                    refname: refname.clone(),
                    oid: oid.clone(),
                });
            }
        }
        for pack in &self.packs {
            if !is_pack_key(pack) {
                return Err(ManifestError::MalformedPackKey(pack.clone()));
            }
        }
        if let Some(p) = &self.parent {
            if !is_manifest_digest(p) {
                return Err(ManifestError::MalformedParent(p.clone()));
            }
        }
        Ok(())
    }

    /// Serialize to canonical bytes suitable for `put_manifest`.
    ///
    /// Sorts `packs` defensively (writer is responsible for keeping them
    /// sorted, but a misuse should not silently break content-addressing).
    ///
    /// Does NOT call `validate()` — callers must invoke it explicitly so a
    /// validation failure is visible at the write seam, not buried inside
    /// serialization.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ManifestError> {
        let mut owned = self.clone();
        owned.packs.sort();
        owned.packs.dedup();
        Ok(serde_json::to_vec(&owned)?)
    }

    /// Parse from bytes; reject unknown schema versions.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ManifestError> {
        let m: Manifest = serde_json::from_slice(bytes)?;
        if m.version != MANIFEST_VERSION {
            return Err(ManifestError::UnsupportedVersion {
                got: m.version,
                expected: MANIFEST_VERSION,
            });
        }
        Ok(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_key(ch: char) -> String {
        format!("packs/{}", ch.to_string().repeat(64))
    }

    fn sample() -> Manifest {
        let mut refs = BTreeMap::new();
        refs.insert(
            "refs/heads/main".into(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        );
        refs.insert(
            "refs/heads/feature".into(),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
        );
        Manifest {
            version: MANIFEST_VERSION,
            head: "refs/heads/main".into(),
            refs,
            packs: vec![pack_key('c'), pack_key('d')],
            parent: Some("ee".repeat(32)),
            published_at: None,
        }
    }

    #[test]
    fn canonical_bytes_round_trip() {
        let m = sample();
        let bytes = m.canonical_bytes().unwrap();
        let back = Manifest::from_bytes(&bytes).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn canonical_bytes_byte_stable_across_ref_insertion_order() {
        // Insert refs in opposite orders; canonical bytes must match because
        // BTreeMap iterates sorted.
        let mut a = sample();
        a.refs.clear();
        a.refs.insert("refs/heads/zzz".into(), "11".repeat(20));
        a.refs.insert("refs/heads/aaa".into(), "22".repeat(20));
        let mut b = sample();
        b.refs.clear();
        b.refs.insert("refs/heads/aaa".into(), "22".repeat(20));
        b.refs.insert("refs/heads/zzz".into(), "11".repeat(20));
        assert_eq!(a.canonical_bytes().unwrap(), b.canonical_bytes().unwrap());
    }

    #[test]
    fn canonical_bytes_sorts_and_dedups_packs() {
        let mut m = sample();
        m.packs = vec![pack_key('d'), pack_key('c'), pack_key('d')];
        let bytes = m.canonical_bytes().unwrap();
        let back = Manifest::from_bytes(&bytes).unwrap();
        assert_eq!(back.packs, vec![pack_key('c'), pack_key('d')]);
    }

    #[test]
    fn safe_refnames_predicate() {
        assert!(is_safe_refname("refs/heads/main"));
        assert!(is_safe_refname("refs/tags/v1.0.0"));
        assert!(is_safe_refname("refs/heads/feat/cas-publish"));
        assert!(!is_safe_refname("refs/heads/../escape"));
        assert!(!is_safe_refname("HEAD"));
        assert!(!is_safe_refname(""));
        assert!(!is_safe_refname("refs/heads/"));
        assert!(!is_safe_refname("/refs/heads/main"));
        assert!(!is_safe_refname("refs/heads/main\nrefs/heads/evil"));
        assert!(!is_safe_refname("refs/heads/main\0"));
    }

    #[test]
    fn hex_oid_predicate() {
        assert!(is_hex_oid(&"a".repeat(40)));
        assert!(is_hex_oid(&"a".repeat(64)));
        assert!(!is_hex_oid(&"a".repeat(39)));
        assert!(!is_hex_oid(&"g".repeat(40)));
        assert!(!is_hex_oid(""));
    }

    #[test]
    fn validate_happy_path() {
        sample().validate().expect("sample manifest must validate");
    }

    /// The empty manifest is the announce-time seed (`side_effects.rs::
    /// seed_manifest_pointer`). It must validate — otherwise repo announce
    /// would fail before the pointer can be seeded, and the read path would
    /// 404 every freshly-announced repo. This pins that contract.
    #[test]
    fn empty_manifest_validates() {
        let m = Manifest {
            version: MANIFEST_VERSION,
            head: "refs/heads/main".into(),
            refs: BTreeMap::new(),
            packs: Vec::new(),
            parent: None,
            published_at: None,
        };
        m.validate().expect("empty manifest is the announce-seed");
        // Canonical bytes must be deterministic + stable so all empty manifests
        // share one digest (idempotent put_manifest, one shared S3 object).
        let bytes = m.canonical_bytes().expect("serialize");
        let s = std::str::from_utf8(&bytes).expect("utf8");
        assert_eq!(
            s,
            r#"{"version":1,"head":"refs/heads/main","refs":{},"packs":[],"parent":null}"#
        );
    }

    #[test]
    fn validate_rejects_empty_head() {
        let mut m = sample();
        m.head = String::new();
        assert!(matches!(m.validate(), Err(ManifestError::EmptyHead)));
    }

    #[test]
    fn validate_rejects_unsafe_head() {
        let mut m = sample();
        m.head = "refs/heads/..".into();
        assert!(matches!(m.validate(), Err(ManifestError::UnsafeRefName(_))));
    }

    #[test]
    fn validate_rejects_non_refs_head() {
        let mut m = sample();
        m.head = "HEAD".into();
        assert!(matches!(m.validate(), Err(ManifestError::UnsafeRefName(_))));
    }

    #[test]
    fn validate_rejects_unsafe_ref_name() {
        let mut m = sample();
        m.refs.insert("refs/heads/bad\nname".into(), "a".repeat(40));
        assert!(matches!(m.validate(), Err(ManifestError::UnsafeRefName(_))));
    }

    #[test]
    fn validate_rejects_malformed_oid() {
        let mut m = sample();
        m.refs
            .insert("refs/heads/ok".into(), "not-a-hex-oid".into());
        assert!(matches!(
            m.validate(),
            Err(ManifestError::MalformedOid { .. })
        ));
    }

    #[test]
    fn validate_rejects_parent_with_store_prefix() {
        // The common bug Perci named: storing the full key in `parent` instead
        // of the bare digest. `Inv_RefDerivedFromParent` reads `parent =
        // pointer.digest`; carrying the prefix breaks the model literal.
        let mut m = sample();
        m.parent = Some(format!("manifests/{}", "a".repeat(64)));
        assert!(matches!(
            m.validate(),
            Err(ManifestError::MalformedParent(_))
        ));
    }

    #[test]
    fn validate_rejects_short_parent() {
        let mut m = sample();
        m.parent = Some("abc".into());
        assert!(matches!(
            m.validate(),
            Err(ManifestError::MalformedParent(_))
        ));
    }

    #[test]
    fn validate_rejects_malformed_pack_key() {
        let mut m = sample();
        m.packs = vec!["packs/not-a-digest".into()];
        assert!(matches!(
            m.validate(),
            Err(ManifestError::MalformedPackKey(_))
        ));
    }

    #[test]
    fn validate_rejects_too_many_packs() {
        let mut m = sample();
        m.packs = (0..=MAX_MANIFEST_PACKS)
            .map(|i| format!("packs/{i:064x}"))
            .collect();
        assert!(matches!(
            m.validate(),
            Err(ManifestError::TooManyPacks { .. })
        ));
    }

    #[test]
    fn validate_accepts_no_parent() {
        let mut m = sample();
        m.parent = None;
        m.validate().expect("no parent is fine (first push)");
    }

    #[test]
    fn pointer_writer_is_covered_by_deletion_taxonomy() {
        let community = CommunityId::from_uuid(uuid::Uuid::from_u128(1));
        let owner = "a".repeat(64);
        let key = pointer_key(community, &owner, "repo");
        let prefixes = buzz_media::tenant_prefixes(*community.as_uuid());

        assert!(prefixes.iter().any(|prefix| key.starts_with(prefix)));
        assert!(buzz_media::is_tenant_owned_key(*community.as_uuid(), &key));
    }

    #[test]
    fn pointer_key_strips_dot_git() {
        let c = CommunityId::from_uuid(uuid::Uuid::from_u128(1));
        assert_eq!(
            pointer_key(c, "alice", "myrepo"),
            format!("repos/{c}/alice/myrepo/pointer")
        );
        assert_eq!(
            pointer_key(c, "alice", "myrepo.git"),
            format!("repos/{c}/alice/myrepo/pointer")
        );
    }

    #[test]
    fn pointer_key_is_community_scoped() {
        let a = CommunityId::from_uuid(uuid::Uuid::from_u128(1));
        let b = CommunityId::from_uuid(uuid::Uuid::from_u128(2));

        assert_ne!(
            pointer_key(a, "alice", "repo"),
            pointer_key(b, "alice", "repo")
        );
        assert_eq!(
            pointer_key(a, "alice", "repo"),
            format!("repos/{a}/alice/repo/pointer")
        );
        assert_ne!(pointer_key(a, "alice", "repo"), "repos/alice/repo/pointer");
    }

    /// Mutate-bite shape for git hosting: same owner/repo string in two
    /// communities must resolve to different pointer cells. If the community
    /// segment is dropped from `pointer_key`, B overwrites A and A observes B's
    /// manifest pointer (wrong answer, not absence).
    #[test]
    fn same_owner_repo_pointers_do_not_bleed_between_communities() {
        use std::collections::HashMap;

        let a = CommunityId::from_uuid(uuid::Uuid::from_u128(1));
        let b = CommunityId::from_uuid(uuid::Uuid::from_u128(2));
        let mut pointers = HashMap::new();

        pointers.insert(pointer_key(a, "alice", "repo"), "manifest-a");
        pointers.insert(pointer_key(b, "alice", "repo"), "manifest-b");

        assert_eq!(pointers[&pointer_key(a, "alice", "repo")], "manifest-a");
        assert_eq!(pointers[&pointer_key(b, "alice", "repo")], "manifest-b");
    }

    fn scope() -> RepoScope {
        RepoScope::new(
            CommunityId::from_uuid(uuid::Uuid::from_u128(1)),
            &"a".repeat(64),
            "myrepo",
        )
        .expect("valid scope")
    }

    #[test]
    fn scope_agrees_with_pointer_key() {
        let c = CommunityId::from_uuid(uuid::Uuid::from_u128(1));
        let owner = "a".repeat(64);
        assert_eq!(
            RepoScope::new(c, &owner, "myrepo.git")
                .expect("scope")
                .pointer_key(),
            pointer_key(c, &owner, "myrepo.git")
        );
    }

    /// The delete path builds a prefix from an event's `a` tag, which no HTTP
    /// route has validated. Anything that could escape the intended namespace
    /// — or name a different repo — must not produce a scope at all.
    #[test]
    fn scope_rejects_identities_that_could_escape_the_namespace() {
        let c = CommunityId::from_uuid(uuid::Uuid::from_u128(1));
        let owner = "a".repeat(64);
        assert!(
            RepoScope::new(c, "alice", "repo").is_none(),
            "owner not hex"
        );
        assert!(
            RepoScope::new(c, &"A".repeat(64), "repo").is_none(),
            "owner must be lowercase"
        );
        for bad in ["", "..", "../other", "a/b", ".hidden", &"x".repeat(65)] {
            assert!(RepoScope::new(c, &owner, bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn scope_containment_does_not_match_a_sibling_with_a_longer_name() {
        let c = CommunityId::from_uuid(uuid::Uuid::from_u128(1));
        let owner = "a".repeat(64);
        let repo = RepoScope::new(c, &owner, "repo").expect("scope");
        let sibling = RepoScope::new(c, &owner, "repo-2").expect("scope");
        assert!(repo.contains(&repo.pointer_key()));
        assert!(!repo.contains(&sibling.pointer_key()));
    }

    #[test]
    fn pack_keys_are_accepted_under_both_layouts() {
        let digest = "a".repeat(64);
        assert!(is_pack_key(&format!("packs/{digest}")));
        assert!(is_pack_key(&format!("{}/{digest}", scope().packs_prefix())));
    }

    #[test]
    fn pack_key_predicate_rejects_near_misses() {
        let digest = "a".repeat(64);
        for bad in [
            format!("manifests/{digest}"),
            format!("idx/{digest}"),
            format!("repos/one/two/packs/{digest}"),
            format!("repos//c/o/r/packs/{digest}"),
            format!("evil/repos/c/o/r/packs/{digest}"),
            format!("{}/{}", scope().packs_prefix(), "g".repeat(64)),
        ] {
            assert!(!is_pack_key(&bad), "{bad}");
        }
    }

    /// A manifest written before namespacing names global pack keys and is
    /// never rewritten, so `validate` must keep accepting it.
    #[test]
    fn validate_accepts_a_manifest_from_before_namespacing() {
        let mut m = sample();
        m.packs = vec![format!("packs/{}", "b".repeat(64))];
        m.validate().expect("legacy pack keys still resolve");
    }

    #[test]
    fn manifest_digest_round_trips_under_both_layouts() {
        let digest = "c".repeat(64);
        assert_eq!(
            digest_of_manifest_key(&format!("manifests/{digest}")),
            Some(digest.as_str())
        );
        assert_eq!(
            digest_of_manifest_key(&format!("{}/{digest}", scope().manifests_prefix())),
            Some(digest.as_str())
        );
        assert_eq!(
            digest_of_manifest_key(&format!("{}/{digest}", scope().packs_prefix())),
            None,
            "a pack key is not a manifest key"
        );
    }

    #[test]
    fn rejects_unknown_version() {
        let mut m = sample();
        m.version = 999;
        let bytes = serde_json::to_vec(&m).unwrap();
        let err = Manifest::from_bytes(&bytes).unwrap_err();
        assert!(matches!(
            err,
            ManifestError::UnsupportedVersion { got: 999, .. }
        ));
    }

    #[test]
    fn first_push_has_no_parent() {
        let mut m = sample();
        m.parent = None;
        let bytes = m.canonical_bytes().unwrap();
        let back = Manifest::from_bytes(&bytes).unwrap();
        assert!(back.parent.is_none());
    }

    /// Pin the exact byte shape so any unintended change to serialization
    /// (field order, whitespace, key ordering) triggers a failure rather than
    /// silently shifting the manifest digest.
    #[test]
    fn canonical_bytes_pinned() {
        let mut refs = BTreeMap::new();
        refs.insert("refs/heads/main".into(), "a".repeat(40));
        let m = Manifest {
            version: 1,
            head: "refs/heads/main".into(),
            refs,
            packs: vec![pack_key('1')],
            parent: None,
            published_at: None,
        };
        let bytes = m.canonical_bytes().unwrap();
        let s = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(
            s,
            format!(
                r#"{{"version":1,"head":"refs/heads/main","refs":{{"refs/heads/main":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"packs":["{}"],"parent":null}}"#,
                pack_key('1')
            )
        );
    }

    #[test]
    fn published_at_serializes_last_and_round_trips() {
        let mut m = sample();
        m.parent = None;
        m.refs.clear();
        m.packs.clear();
        m.published_at = Some(1_700_000_000);
        let bytes = m.canonical_bytes().unwrap();
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            r#"{"version":1,"head":"refs/heads/main","refs":{},"packs":[],"parent":null,"published_at":1700000000}"#
        );
        assert_eq!(Manifest::from_bytes(&bytes).unwrap(), m);
    }

    #[test]
    fn manifests_without_published_at_still_parse() {
        let legacy =
            br#"{"version":1,"head":"refs/heads/main","refs":{},"packs":[],"parent":null}"#;
        let m = Manifest::from_bytes(legacy).unwrap();
        assert_eq!(m.published_at, None);
        assert_eq!(m.canonical_bytes().unwrap(), legacy.to_vec());
    }

    #[test]
    fn next_published_at_strictly_follows_the_parent() {
        let mut parent = sample();
        parent.published_at = None;
        assert_eq!(next_published_at(&parent, 100), 101);

        parent.published_at = Some(90);
        assert_eq!(next_published_at(&parent, 100), 100);
        // Same second as the parent.
        parent.published_at = Some(100);
        assert_eq!(next_published_at(&parent, 100), 101);
        // The parent's instance clock ran ahead of ours.
        parent.published_at = Some(105);
        assert_eq!(next_published_at(&parent, 100), 106);
    }
}
