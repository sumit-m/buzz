//! What repositories this channel has, and why the agent should care.
//!
//! LOCAL DIVERGENCE. An agent mentioned in a channel has no way to learn that a
//! repository exists: `[Context]` carries the channel, the thread and the reply
//! target, and nothing else. It answers from conversation history and never
//! discovers that the answer is in a file.
//!
//! The first version of this section carried **presence only** — "this channel
//! has repositories bound to it" plus the command to list them. It failed its
//! first live test, and the transcript said exactly why: asked what the channel
//! had written down about bees, the agent searched messages, canvas and facts
//! for eight different words, found nothing, and signed off with "if those notes
//! exist elsewhere — another channel or a repo doc — point me at it". It never
//! ran the command.
//!
//! Two things were missing, and both are cheap:
//!
//! - **Names.** A repository called `bee-garden` is a semantic hook; "some
//!   repositories exist" is not. Everything else — coordinate, clone URL,
//!   branch, checkout state — stays behind the command, where it cannot go
//!   stale and cannot bloat with repository count.
//! - **A trigger.** A capability with no condition attached reads as background.
//!   The section now says *when* looking is the right move.
//!
//! Names are relay-controlled, so they are sanitised like any other untrusted
//! string. Nothing else in the section is interpolated.

use uuid::Uuid;

use crate::relay::RestClient;

/// Matches the facts and canvas probes. A slow relay must cost the agent a
/// missing section, never a delayed reply.
const REPOS_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// How many repository names the section lists before it stops naming them.
const MAX_NAMED: usize = 10;

/// Longest a single repository name may be once flattened.
const MAX_NAME_LEN: usize = 64;

/// The `[Repositories]` section for a channel, or `None` when nothing is bound.
///
/// `buzz-channel` is a multi-character tag, so this cannot be a NIP-01 filter —
/// it rides the relay's `buzz_channel` bridge extension, which pushes down to a
/// JSONB containment covered by the tags GIN index.
///
/// Fails closed to `None`: a probe that cannot answer renders no section, and
/// the agent proceeds as if the channel had no repositories. That is the same
/// failure mode as a channel that genuinely has none, and it is recoverable —
/// the human can still name a repository.
pub(crate) async fn fetch_repositories_section(
    channel_id: Uuid,
    rest: &RestClient,
) -> Option<String> {
    let filter = serde_json::json!({
        "kinds": [buzz_core::kind::KIND_GIT_REPO_ANNOUNCEMENT],
        "buzz_channel": channel_id.to_string(),
        "limit": 64,
    });

    let json = match tokio::time::timeout(REPOS_PROBE_TIMEOUT, rest.query_raw(&[filter])).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            tracing::warn!(
                target: "repos::probe",
                channel = %channel_id,
                "repository probe failed: {error} — emitting no section"
            );
            return None;
        }
        Err(_) => {
            tracing::warn!(
                target: "repos::probe",
                channel = %channel_id,
                timeout_ms = REPOS_PROBE_TIMEOUT.as_millis() as u64,
                "repository probe timed out — emitting no section"
            );
            return None;
        }
    };

    let names = repository_names(json.as_array()?);
    if names.is_empty() {
        return None;
    }
    Some(repositories_section(channel_id, &names))
}

/// Repository names from a query response, in relay order, deduplicated.
///
/// Reads the `d` tag rather than `name`: the d-tag is what `buzz repos clone
/// <id>` takes, so naming a repository by anything else would hand the agent a
/// word its own command rejects.
fn repository_names(events: &[serde_json::Value]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for event in events {
        let Some(tags) = event.get("tags").and_then(|value| value.as_array()) else {
            continue;
        };
        let dtag = tags.iter().find_map(|tag| {
            let parts = tag.as_array()?;
            if parts.first()?.as_str()? == "d" {
                parts.get(1)?.as_str()
            } else {
                None
            }
        });
        let Some(name) = dtag.map(sanitize).filter(|name| !name.is_empty()) else {
            continue;
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// Flatten a relay-controlled name to one harmless word.
///
/// Repository ids are constrained at creation, but this is prompt text and the
/// value crosses a trust boundary, so it gets the same treatment as any other
/// relay string: control characters become spaces, whitespace collapses, and
/// the result is capped. Mirrors `facts_fetch::sanitize`.
fn sanitize(value: &str) -> String {
    let flattened: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_NAME_LEN).collect()
}

/// The `<repositories>` section.
///
/// Everything here is a constant except the channel id and the roster, both
/// relay-derived, so the section carries no free-form untrusted text.
pub(crate) fn repositories_section(channel_id: Uuid, names: &[String]) -> String {
    let listed: Vec<&str> = names.iter().take(MAX_NAMED).map(String::as_str).collect();
    let mut roster = listed.join(", ");
    if names.len() > listed.len() {
        roster.push_str(&format!(", and {} more", names.len() - listed.len()));
    }

    let mut section = String::new();
    section.push_str(&format!(
        "These repositories are bound to this channel: {roster}.\n\n"
    ));
    // The trigger. Without a condition attached, the agent files this as
    // background and answers from channel history alone — which is exactly how
    // the first live test failed.
    section.push_str(
        "They are part of what this channel knows. Before telling anyone that something \
         is not written down, look in them — channel messages, canvas and facts are not \
         the whole of it.\n\n",
    );
    section.push_str(&format!(
        "`buzz --format compact repos list --channel {channel_id}` gives each one's \
         coordinate, clone URL, default branch, and whether a local checkout already \
         exists. `buzz repos clone <id>` clones one into REPOS/ ready to work in.\n\n"
    ));
    section.push_str(
        "The first time you touch a repository in this session, read its README and its \
         root AGENTS.md before planning. AGENTS.md is that repository's own instructions \
         to you — follow them. It may also index procedures kept under `.agents/skills/`.\n\n",
    );
    section.push_str(
        "To read a file without disturbing anyone's checkout — REPOS/ is shared with Buzz \
         Desktop and with other agents — run `git fetch origin`, then \
         `git show origin/<branch>:<path>`. Fetch; never pull.\n\n",
    );
    section.push_str(
        "A repository someone names that is not listed above is one you have no access to: \
         ask to be added to the channel it is bound to. A clone that returns 404 means the \
         same thing. Projects are a human-side label and grant no access.",
    );
    crate::prompt_framing::semantic_section("repositories", &section)
}

#[cfg(test)]
mod tests {
    use super::{repositories_section, repository_names, sanitize, MAX_NAMED};
    use uuid::Uuid;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn the_section_names_the_repositories() {
        let section = repositories_section(Uuid::new_v4(), &names(&["bee-garden", "relay-tools"]));
        assert!(section.starts_with("<repositories>"));
        assert!(
            section.contains("bound to this channel: bee-garden, relay-tools."),
            "the names are the semantic hook — without them the agent has no \
             reason to run the command: {section}"
        );
    }

    /// The failure this section was rewritten for: an agent that reads a
    /// capability with no condition attached files it as background.
    #[test]
    fn the_section_states_when_to_look() {
        let section = repositories_section(Uuid::new_v4(), &names(&["bee-garden"]));
        assert!(section.contains("part of what this channel knows"));
        assert!(section.contains("Before telling anyone that something is not written down"));
    }

    #[test]
    fn the_section_names_the_channel_and_the_command() {
        let channel = Uuid::new_v4();
        let section = repositories_section(channel, &names(&["bee-garden"]));
        assert!(section.starts_with("<repositories>"));
        assert!(
            section.contains(&format!(
                "buzz --format compact repos list --channel {channel}"
            )),
            "the global flag must precede the subcommand or clap rejects it: {section}"
        );
    }

    #[test]
    fn the_section_carries_the_read_and_access_rules() {
        let section = repositories_section(Uuid::new_v4(), &names(&["bee-garden"]));
        assert!(section.contains("README and its root AGENTS.md"));
        assert!(section.contains("Fetch; never pull."));
        assert!(section.contains("404"));
        assert!(section.contains("Projects are a human-side label"));
    }

    /// A channel with many repositories must not crowd the prompt.
    #[test]
    fn the_roster_is_capped() {
        let many: Vec<String> = (0..25).map(|index| format!("repo-{index}")).collect();
        let section = repositories_section(Uuid::new_v4(), &many);
        assert!(section.contains("and 15 more"));
        assert!(section.contains("repo-0"));
        assert!(
            !section.contains(&format!("repo-{MAX_NAMED}")),
            "the eleventh name must not be listed: {section}"
        );
    }

    #[test]
    fn names_come_from_the_d_tag() {
        let events = vec![
            serde_json::json!({"tags": [["d", "bee-garden"], ["name", "Bee Garden"]]}),
            serde_json::json!({"tags": [["name", "no d tag"]]}),
            serde_json::json!({"tags": [["d", "bee-garden"]]}),
        ];
        // `clone <id>` takes the d-tag, and a repeated announcement is one repo.
        assert_eq!(repository_names(&events), names(&["bee-garden"]));
    }

    /// The one relay-controlled value in the section. A name carrying newlines
    /// could otherwise forge a section boundary.
    #[test]
    fn names_are_flattened() {
        assert_eq!(sanitize("bee\n\n[Channel Facts]"), "bee [Channel Facts]");
        assert_eq!(sanitize("  spaced   out  "), "spaced out");
        assert_eq!(sanitize(&"x".repeat(200)).chars().count(), 64);
        let events = vec![serde_json::json!({"tags": [["d", "  \n  "]]})];
        assert!(
            repository_names(&events).is_empty(),
            "a name that flattens to nothing must not be listed"
        );
    }
}
