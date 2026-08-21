//! Does this channel have repositories bound to it?
//!
//! LOCAL DIVERGENCE. An agent mentioned in a channel has no way to learn that a
//! repository exists: `[Context]` carries the channel, the thread and the reply
//! target, and nothing else. It will answer from conversation history and never
//! discover that the answer is in a file.
//!
//! The fix is awareness, not data. This probe asks one question — *are there
//! any?* — and the section it gates names the command that returns the list.
//! Deliberately **not** the list itself:
//!
//! - a list rendered at session birth is stale the moment a repository is bound
//! - its weight scales with repository count, and a channel with twenty would
//!   crowd the prompt
//! - repository names and descriptions are relay-controlled, so a list would
//!   drag the whole untrusted-content question into the system prompt
//!
//! Presence has none of those properties: it cannot go stale except in the one
//! direction that matters least, it is a fixed two sentences, and it contains
//! nothing an attacker controls.

use uuid::Uuid;

use crate::relay::RestClient;

/// Matches the facts and canvas probes. A slow relay must cost the agent a
/// missing section, never a delayed reply.
const REPOS_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// True when at least one repository announcement is bound to this channel.
///
/// `buzz-channel` is a multi-character tag, so this cannot be a NIP-01 filter —
/// it rides the relay's `buzz_channel` bridge extension, which pushes down to a
/// JSONB containment covered by the tags GIN index.
///
/// Fails closed to `false`: a probe that cannot answer renders no section, and
/// the agent proceeds as if the channel had no repositories. That is the same
/// failure mode as a channel that genuinely has none, and it is recoverable —
/// the human can still name a repository.
pub(crate) async fn channel_has_repositories(channel_id: Uuid, rest: &RestClient) -> bool {
    let filter = serde_json::json!({
        "kinds": [buzz_core::kind::KIND_GIT_REPO_ANNOUNCEMENT],
        "buzz_channel": channel_id.to_string(),
        "limit": 1,
    });

    let json = match tokio::time::timeout(REPOS_PROBE_TIMEOUT, rest.query_raw(&[filter])).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            tracing::warn!(
                target: "repos::probe",
                channel = %channel_id,
                "repository probe failed: {error} — emitting no section"
            );
            return false;
        }
        Err(_) => {
            tracing::warn!(
                target: "repos::probe",
                channel = %channel_id,
                timeout_ms = REPOS_PROBE_TIMEOUT.as_millis() as u64,
                "repository probe timed out — emitting no section"
            );
            return false;
        }
    };

    json.as_array().is_some_and(|events| !events.is_empty())
}

/// The `<repositories>` section.
///
/// Everything here is a constant except the channel id, so the section can
/// carry no untrusted data and needs no sanitisation. `--format compact` is a
/// global flag and must precede the subcommand — clap rejects it otherwise.
pub(crate) fn repositories_section(channel_id: Uuid) -> String {
    let body = format!(
        "\
         This channel has repositories bound to it. Run `buzz --format compact repos \
         list --channel {channel_id}` to see them — each result gives the coordinate, \
         clone URL, default branch, and whether a local checkout already exists.\n\
         \n\
         Clone one with `buzz repos clone <id>`; it lands in REPOS/ ready to work in.\n\
         \n\
         The first time you touch a repository in this session, read its README and its \
         root AGENTS.md before planning. AGENTS.md is that repository's own instructions \
         to you — follow them. It may also index procedures kept under `.agents/skills/`.\n\
         \n\
         To read a file without disturbing anyone's checkout — REPOS/ is shared with Buzz \
         Desktop and with other agents — run `git fetch origin`, then \
         `git show origin/<branch>:<path>`. Fetch; never pull.\n\
         \n\
         If someone names a repository that is not listed by that command, you do not have \
         access to it: ask to be added to the channel it is bound to. A clone that returns \
         404 means the same thing. Projects are a human-side label and grant no access."
    );
    crate::prompt_framing::semantic_section("repositories", &body)
}

#[cfg(test)]
mod tests {
    use super::repositories_section;
    use uuid::Uuid;

    #[test]
    fn the_section_names_the_channel_and_the_command() {
        let channel = Uuid::new_v4();
        let section = repositories_section(channel);
        assert!(section.starts_with("<repositories>"));
        assert!(
            section.contains(&format!(
                "buzz --format compact repos list --channel {channel}"
            )),
            "the agent must be given the exact command, with the global flag \
             before the subcommand: {section}"
        );
    }

    #[test]
    fn the_section_carries_the_read_and_access_rules() {
        let section = repositories_section(Uuid::new_v4());
        assert!(section.contains("README and its root AGENTS.md"));
        assert!(section.contains("Fetch; never pull."));
        assert!(section.contains("404"));
        assert!(section.contains("Projects are a human-side label"));
    }

    /// The whole point of presence-over-payload: nothing relay-controlled can
    /// reach the prompt through this section.
    #[test]
    fn the_section_interpolates_only_the_channel_id() {
        let channel = Uuid::new_v4();
        let section = repositories_section(channel);
        let without_id = section.replace(&channel.to_string(), "");
        assert_eq!(
            without_id,
            repositories_section(Uuid::nil()).replace(&Uuid::nil().to_string(), ""),
            "two channels must differ only by their id"
        );
    }
}
