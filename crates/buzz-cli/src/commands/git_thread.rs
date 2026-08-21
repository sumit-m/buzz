//! Reading what happened to an issue or a pull request after it was created.
//!
//! LOCAL DIVERGENCE. `issues get` and `pr get` return the root event — the
//! thing its author already wrote. Everything that follows is separate events:
//! approvals, change requests, inline comments, assignment operations, and the
//! kind:1630-1633 status. None of them come back, so an agent that opens a pull
//! request cannot answer "was it merged?" and cannot see that a human asked for
//! changes. The loop is one-way.
//!
//! Nothing here is new capability. The relay already answers this query, and
//! `issues::issue_assignment_context` performs the same shape internally to
//! work out assignees. This exposes it.
//!
//! ## Trust is not optional
//!
//! Buzz's review vocabulary is not in the protocol. NIP-34 defines the root and
//! the status; approvals, change requests and review requests are ordinary
//! kind:1 notes carrying a `t` label, a convention Buzz Desktop invented. Any
//! relay user can publish a note labelled `approval` pointing at someone else's
//! pull request.
//!
//! Desktop therefore honours a labelled event only from the root's author or
//! the repository owner (`allowedActorsForRoot` in
//! `desktop/src/features/projects/projectIssues.mjs`), and this mirrors that
//! rule exactly.
//!
//! It *marks* rather than filters. Dropping untrusted events would hide that
//! someone tried, which is worth seeing; an agent should act on `trusted` ones
//! and be able to report the rest.

use std::collections::BTreeSet;

use serde_json::{json, Value};

/// Kinds 1630-1633: open, applied/merged/resolved, closed, draft.
pub(crate) const STATUS_KINDS: [u64; 4] = [1630, 1631, 1632, 1633];

/// Which root an event thread hangs off, and therefore what its statuses are
/// called. NIP-34 shares kinds 1630-1633 between the two, but 1631 means
/// "merged" for a pull request and "resolved" for an issue — the vocabulary
/// `buzz pr status` and `buzz issues status` already accept.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum RootKind {
    PullRequest,
    Issue,
}

impl RootKind {
    fn status_name(self, kind: u64) -> Option<&'static str> {
        match (self, kind) {
            (_, 1630) => Some("open"),
            (Self::PullRequest, 1631) => Some("merged"),
            (Self::Issue, 1631) => Some("resolved"),
            (_, 1632) => Some("closed"),
            (_, 1633) => Some("draft"),
            _ => None,
        }
    }
}

fn tag_value<'a>(event: &'a Value, name: &str) -> Option<&'a str> {
    event.get("tags")?.as_array()?.iter().find_map(|tag| {
        let parts = tag.as_array()?;
        (parts.first()?.as_str()? == name).then(|| parts.get(1)?.as_str())?
    })
}

fn tag_values(event: &Value, name: &str) -> Vec<String> {
    event
        .get("tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter()
                .filter_map(|tag| {
                    let parts = tag.as_array()?;
                    (parts.first()?.as_str()? == name)
                        .then(|| parts.get(1)?.as_str().map(String::from))?
                })
                .collect()
        })
        .unwrap_or_default()
}

fn pubkey(event: &Value) -> String {
    event
        .get("pubkey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// The signers whose labelled events count: the root's author, and the owner
/// of the repository the root is filed against.
///
/// Mirrors `allowedActorsForRoot`. The owner comes out of the `a` tag —
/// `30617:<owner>:<repo-id>` — which is the only place the root records it.
pub(crate) fn allowed_actors(root: &Value) -> BTreeSet<String> {
    let mut allowed = BTreeSet::new();
    allowed.insert(pubkey(root));
    if let Some(address) = tag_value(root, "a") {
        if let Some(owner) = address.split(':').nth(1) {
            if !owner.is_empty() {
                allowed.insert(owner.to_ascii_lowercase());
            }
        }
    }
    allowed
}

/// True when the event carries `["e", <root-id>, ..]`.
///
/// Checked rather than assumed: the relay filter asks for `#e`, but a single
/// note can reference several events, and a status event that names a different
/// root must not decide this one's state.
fn references_root(event: &Value, root_id: &str) -> bool {
    event
        .get("tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| {
            tags.iter().any(|tag| {
                let Some(parts) = tag.as_array() else {
                    return false;
                };
                parts.first().and_then(Value::as_str) == Some("e")
                    && parts.get(1).and_then(Value::as_str) == Some(root_id)
            })
        })
}

fn created_at(event: &Value) -> i64 {
    event.get("created_at").and_then(Value::as_i64).unwrap_or(0)
}

/// The current status: the newest **trusted** status event naming this root.
///
/// Untrusted status events are ignored entirely rather than marked, because
/// this is a single answer rather than a list — surfacing an untrusted one here
/// would let any relay user flip what an agent believes about its own work.
/// They remain visible in `events`.
fn latest_status(root: &Value, root_id: &str, statuses: &[Value], kind: RootKind) -> Value {
    let allowed = allowed_actors(root);
    let newest = statuses
        .iter()
        .filter(|event| allowed.contains(&pubkey(event)) && references_root(event, root_id))
        .filter(|event| {
            event
                .get("kind")
                .and_then(Value::as_u64)
                .is_some_and(|k| STATUS_KINDS.contains(&k))
        })
        .max_by_key(|event| created_at(event));

    match newest {
        Some(event) => {
            let event_kind = event
                .get("kind")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            json!({
                "state": kind.status_name(event_kind),
                "kind": event_kind,
                "by": pubkey(event),
                "at": created_at(event),
            })
        }
        // No status event is not the same as "closed" or "unknown": NIP-34
        // treats an unstated status as open, and so does Desktop.
        None => {
            json!({ "state": "open", "kind": Value::Null, "by": Value::Null, "at": Value::Null })
        }
    }
}

/// One comment, projected to what an agent has to decide on.
fn project_comment(root_id: &str, event: &Value, allowed: &BTreeSet<String>) -> Value {
    let labels = tag_values(event, "t");
    let file = tag_value(event, "file");
    let line = tag_value(event, "line");
    let side = tag_value(event, "side");
    let anchor = file.map(|path| {
        json!({
            "file": path,
            "line": line.and_then(|value| value.parse::<i64>().ok()),
            "side": side,
        })
    });
    json!({
        "id": event.get("id").and_then(Value::as_str),
        "author": pubkey(event),
        "at": created_at(event),
        "labels": labels,
        // Whether a labelled claim counts. See the module docs: any user can
        // publish a note labelled `approval`; only these signers are honoured.
        "trusted": allowed.contains(&pubkey(event)),
        "body": event.get("content").and_then(Value::as_str).unwrap_or(""),
        "commit": tag_value(event, "c"),
        "anchor": anchor,
        "reviewers": tag_values(event, "p"),
        "references_root": references_root(event, root_id),
    })
}

/// The whole thread, projected: current state first, then what was said.
///
/// Shaped around the three questions an agent actually has — what is the state
/// now, did anyone approve or ask for changes, and what did they say and where.
pub(crate) fn project_thread(
    root: &Value,
    comments: &[Value],
    statuses: &[Value],
    kind: RootKind,
) -> Value {
    let root_id = root.get("id").and_then(Value::as_str).unwrap_or_default();
    let allowed = allowed_actors(root);

    let mut projected: Vec<Value> = comments
        .iter()
        .filter(|event| references_root(event, root_id))
        .map(|event| project_comment(root_id, event, &allowed))
        .collect();
    projected.sort_by_key(|comment| comment.get("at").and_then(Value::as_i64).unwrap_or(0));

    json!({
        "id": root_id,
        "kind": root.get("kind").and_then(Value::as_u64),
        "author": pubkey(root),
        "status": latest_status(root, root_id, statuses, kind),
        "comments": projected,
    })
}

/// Fetch and project a thread. Shared by `pr comments` and `issues comments`.
///
/// Two filters in one round trip. Both key on the same `e` tag: status events
/// carry `["e", <root>, "", "root"]` (`buzz_sdk::build_git_status`), which is
/// the tag comments use, so the root id alone finds everything hanging off it.
pub(crate) async fn fetch_thread(
    client: &crate::client::BuzzClient,
    root_kind_number: u64,
    root_id: &str,
    kind: RootKind,
    limit: Option<u32>,
) -> Result<Value, crate::error::CliError> {
    crate::validate::validate_hex64(root_id)?;
    let comment_limit = limit.unwrap_or(500);
    let filters = vec![
        json!({ "kinds": [root_kind_number], "ids": [root_id], "limit": 1 }),
        json!({ "kinds": [1], "#e": [root_id], "limit": comment_limit }),
        json!({ "kinds": STATUS_KINDS, "#e": [root_id], "limit": 100 }),
    ];
    let raw = client.query_multi(&filters).await?;
    let events: Vec<Value> = serde_json::from_str(&raw).map_err(|error| {
        crate::error::CliError::Other(format!("failed to parse relay response: {error}"))
    })?;

    let event_kind = |event: &Value| {
        event
            .get("kind")
            .and_then(Value::as_u64)
            .unwrap_or_default()
    };
    let root = events
        .iter()
        .find(|event| {
            event_kind(event) == root_kind_number
                && event.get("id").and_then(Value::as_str) == Some(root_id)
        })
        .cloned()
        .ok_or_else(|| {
            crate::error::CliError::NotFound(format!(
                "no {} found with id {root_id:?} — it may be in a channel you are not a member of",
                match kind {
                    RootKind::PullRequest => "pull request",
                    RootKind::Issue => "issue",
                }
            ))
        })?;

    let comments: Vec<Value> = events
        .iter()
        .filter(|event| event_kind(event) == 1)
        .cloned()
        .collect();
    let statuses: Vec<Value> = events
        .iter()
        .filter(|event| STATUS_KINDS.contains(&event_kind(event)))
        .cloned()
        .collect();

    Ok(project_thread(&root, &comments, &statuses, kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const AUTHOR: &str = "bb11cc22dd33ee44ff55aa66bb11cc22dd33ee44ff55aa66bb11cc22dd33ee44";
    const STRANGER: &str = "cc11dd22ee33ff44aa55bb66cc11dd22ee33ff44aa55bb66cc11dd22ee33ff44";
    const ROOT_ID: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    fn root() -> Value {
        json!({
            "id": ROOT_ID,
            "kind": 1618,
            "pubkey": AUTHOR,
            "content": "please review",
            "tags": [["a", format!("30617:{OWNER}:repo")]],
        })
    }

    fn note(author: &str, at: i64, labels: &[&str], body: &str, extra: Vec<Value>) -> Value {
        let mut tags = vec![json!(["e", ROOT_ID, "", "root"])];
        for label in labels {
            tags.push(json!(["t", label]));
        }
        tags.extend(extra);
        json!({
            "id": format!("{at:064}"),
            "kind": 1,
            "pubkey": author,
            "created_at": at,
            "content": body,
            "tags": tags,
        })
    }

    fn status(author: &str, at: i64, kind: u64) -> Value {
        json!({
            "id": format!("{at:064}"),
            "kind": kind,
            "pubkey": author,
            "created_at": at,
            "tags": [["e", ROOT_ID, "", "root"]],
        })
    }

    /// The repo owner is only recorded in the `a` tag, so a projection that
    /// does not parse it would treat every owner action as untrusted.
    #[test]
    fn the_repo_owner_and_the_author_are_both_trusted() {
        let allowed = allowed_actors(&root());
        assert!(allowed.contains(AUTHOR));
        assert!(allowed.contains(OWNER));
        assert!(!allowed.contains(STRANGER));
    }

    #[test]
    fn the_newest_trusted_status_is_the_status() {
        let statuses = vec![
            status(OWNER, 100, 1630),
            status(OWNER, 300, 1631),
            status(OWNER, 200, 1632),
        ];
        let thread = project_thread(&root(), &[], &statuses, RootKind::PullRequest);
        assert_eq!(thread["status"]["state"], json!("merged"));
        assert_eq!(thread["status"]["at"], json!(300));
    }

    /// The exploit this closes: anyone may publish kind:1632 naming someone
    /// else's pull request. If that decided the state, a stranger could
    /// convince an agent its work was closed.
    #[test]
    fn a_stranger_cannot_set_the_status() {
        let statuses = vec![status(OWNER, 100, 1630), status(STRANGER, 900, 1632)];
        let thread = project_thread(&root(), &[], &statuses, RootKind::PullRequest);
        assert_eq!(thread["status"]["state"], json!("open"));
        assert_eq!(thread["status"]["by"], json!(OWNER));
    }

    /// NIP-34 treats an unstated status as open, and so must this — "no status
    /// event" is not "unknown".
    #[test]
    fn no_status_event_reads_as_open() {
        let thread = project_thread(&root(), &[], &[], RootKind::PullRequest);
        assert_eq!(thread["status"]["state"], json!("open"));
        assert_eq!(thread["status"]["kind"], Value::Null);
    }

    /// 1631 is shared between the two roots and means different things.
    #[test]
    fn an_issue_resolves_where_a_pull_request_merges() {
        let statuses = vec![status(OWNER, 100, 1631)];
        let issue = project_thread(&root(), &[], &statuses, RootKind::Issue);
        assert_eq!(issue["status"]["state"], json!("resolved"));
        let pr = project_thread(&root(), &[], &statuses, RootKind::PullRequest);
        assert_eq!(pr["status"]["state"], json!("merged"));
    }

    /// Marked, not filtered — hiding it would conceal that someone tried.
    #[test]
    fn an_untrusted_approval_is_visible_and_flagged() {
        let comments = vec![
            note(OWNER, 100, &["approval"], "looks good", vec![]),
            note(STRANGER, 200, &["approval"], "I approve of myself", vec![]),
        ];
        let thread = project_thread(&root(), &comments, &[], RootKind::PullRequest);
        let comments = thread["comments"].as_array().expect("comments");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0]["trusted"], json!(true));
        assert_eq!(comments[1]["trusted"], json!(false));
        assert_eq!(comments[1]["labels"], json!(["approval"]));
    }

    #[test]
    fn an_inline_comment_keeps_its_anchor() {
        let comments = vec![note(
            OWNER,
            100,
            &["inline-comment"],
            "off by one",
            vec![
                json!(["file", "src/main.rs"]),
                json!(["line", "42"]),
                json!(["side", "new"]),
                json!(["c", "d".repeat(40)]),
            ],
        )];
        let thread = project_thread(&root(), &comments, &[], RootKind::PullRequest);
        let comment = &thread["comments"][0];
        assert_eq!(comment["anchor"]["file"], json!("src/main.rs"));
        assert_eq!(comment["anchor"]["line"], json!(42));
        assert_eq!(comment["anchor"]["side"], json!("new"));
        assert_eq!(comment["commit"], json!("d".repeat(40)));
    }

    /// A note with no labels is an ordinary comment, not a review action.
    #[test]
    fn a_plain_comment_carries_no_labels_and_no_anchor() {
        let comments = vec![note(OWNER, 100, &[], "why this way?", vec![])];
        let thread = project_thread(&root(), &comments, &[], RootKind::PullRequest);
        let comment = &thread["comments"][0];
        assert_eq!(comment["labels"], json!([]));
        assert_eq!(comment["anchor"], Value::Null);
        assert_eq!(comment["body"], json!("why this way?"));
    }

    /// The relay filter asks for `#e`, but one note can name several events.
    /// A comment on a different pull request must not appear in this thread.
    #[test]
    fn an_event_naming_a_different_root_is_dropped() {
        let mut foreign = note(OWNER, 100, &["approval"], "on something else", vec![]);
        foreign["tags"] = json!([["e", "9".repeat(64), "", "root"]]);
        let thread = project_thread(&root(), &[foreign], &[], RootKind::PullRequest);
        assert!(thread["comments"].as_array().expect("comments").is_empty());
    }

    #[test]
    fn comments_come_back_oldest_first() {
        let comments = vec![
            note(OWNER, 300, &[], "third", vec![]),
            note(OWNER, 100, &[], "first", vec![]),
            note(OWNER, 200, &[], "second", vec![]),
        ];
        let thread = project_thread(&root(), &comments, &[], RootKind::PullRequest);
        let bodies: Vec<&str> = thread["comments"]
            .as_array()
            .expect("comments")
            .iter()
            .map(|comment| comment["body"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(bodies, vec!["first", "second", "third"]);
    }
}
