//! Whether this channel has repositories, and why the agent should care.
//!
//! LOCAL DIVERGENCE. An agent mentioned in a channel has no way to learn that a
//! repository exists: `[Context]` carries the channel, the thread and the reply
//! target, and nothing else. It answers from conversation history and never
//! discovers that the answer is in a file.
//!
//! ## What the first live test taught
//!
//! Version one said "this channel has repositories bound to it" and named the
//! command to list them. Asked what the channel had written down about bees,
//! the agent searched messages, canvas and facts for eight different words,
//! found nothing, and signed off with *"if those notes exist elsewhere —
//! another channel or a repo doc — point me at it"*. It never ran the command.
//!
//! It had reached the exact moment the section exists for and stopped, because
//! the section stated a **capability with no condition attached**, which reads
//! as background. The fix is the trigger, and it goes *first* — before the
//! command, naming the moment: about to conclude that something cannot be
//! answered or is not written down.
//!
//! ## Why no list of names
//!
//! Naming the repositories would give a stronger hook — an agent asked about
//! bees connects the question to `bee-garden` immediately. It was tried and
//! then deliberately reverted, because a list rendered at session birth is
//! stale the moment a repository is bound, grows with repository count, and
//! drags relay-controlled strings into the system prompt. Presence plus a
//! trigger keeps the section constant: nothing here can go stale, and nothing
//! an attacker controls reaches the prompt. The command returns ground truth.
//!
//! If a future test shows the trigger alone is not enough, names are the next
//! lever — see git history for the version that had them.

use uuid::Uuid;

use crate::relay::RestClient;

/// Matches the facts and canvas probes. A slow relay must cost the agent a
/// missing section, never a delayed reply.
const REPOS_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// True when at least one repository announcement is bound to this channel.
///
/// `buzz-channel` is a multi-character tag, so `nostr::Filter` cannot model it —
/// it rides the relay's `#buzz-channel` raw-filter extension, which pushes down
/// to a JSONB containment covered by the tags GIN index. `limit: 1` because the
/// answer is a yes/no: the section names a command rather than a list.
///
/// Fails closed to `false`: a probe that cannot answer renders no section, and
/// the agent proceeds as if the channel had no repositories. That is the same
/// failure mode as a channel that genuinely has none, and it is recoverable —
/// the human can still name a repository.
pub(crate) async fn channel_has_repositories(channel_id: Uuid, rest: &RestClient) -> bool {
    let filter = serde_json::json!({
        "kinds": [buzz_core::kind::KIND_GIT_REPO_ANNOUNCEMENT],
        "#buzz-channel": [channel_id.to_string()],
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
/// Everything is a constant except the channel id, so nothing can go stale and
/// nothing relay-authored reaches the system prompt.
pub(crate) fn repositories_section(channel_id: Uuid) -> String {
    let mut section = String::new();
    // The trigger, first and before the command — see the module docs.
    section.push_str(concat!(
        "This channel has repositories bound to it, and they are part of what it knows. ",
        "Before concluding that you cannot answer, or that something is not written down, ",
        "look in them — channel messages, canvas and facts are not the whole of it.\n\n",
    ));
    section.push_str(&format!(
        concat!(
            "`buzz --format compact repos list --channel {channel_id}` names them and gives ",
            "each one's coordinate, clone URL, default branch, and whether a local checkout ",
            "already exists. When `checkout` is null, `buzz repos clone <coordinate>` clones ",
            "it into REPOS/ ready to work in — pass the coordinate the listing printed, not ",
            "the bare name, or the lookup only sees repositories you own yourself.\n\n"
        ),
        channel_id = channel_id
    ));
    section.push_str(concat!(
        "The first time you touch a repository in this session, read its README and its ",
        "root AGENTS.md before planning. AGENTS.md is that repository's own instructions ",
        "to you — follow them. It may also index procedures kept under `.agents/skills/`.\n\n",
    ));
    section.push_str(concat!(
        "To read a file without disturbing anyone's checkout — REPOS/ is shared with Buzz ",
        "Desktop and with other agents — run `git fetch origin`, then ",
        "`git show origin/<branch>:<path>`. Fetch; never pull.\n\n",
    ));
    section.push_str(concat!(
        "A repository someone names that is not listed by that command is one you have no ",
        "access to: ask to be added to the channel it is bound to. A clone that returns 404 ",
        "means the same thing. Projects are a human-side label and grant no access.\n\n",
    ));
    // Deliberately two sentences. Whether to file is the repository's call, and
    // the mechanics are enforced by the commands themselves — `pr open` refuses
    // a tip that was never pushed and computes the merge base — so there is
    // nothing more to teach here. Every extra line dilutes the trigger above,
    // which is what the first live test showed gets a section ignored.
    section.push_str(concat!(
        "`buzz issues` files and assigns tasks; `buzz pr` opens pull requests, and ",
        "`buzz pr comments` reads what a reviewer said and whether yours was merged. ",
        "Whether a repository wants a task filed or a review opened is stated in its own ",
        "AGENTS.md — if it says nothing, do neither and just report what you did.\n\n",
    ));
    // The requester is a pubkey in `<context>`, not a display name, so this
    // is unambiguous. Whoever asked for the work should be able to see what
    // came back without going looking for it.
    section.push_str(concat!(
        "Opening a pull request: add whoever asked as a reviewer, with the ",
        "`Requested by` pubkey from <context> as `pr open --to`.",
    ));
    crate::prompt_framing::semantic_section("repositories", &section)
}

#[cfg(test)]
mod tests {
    use super::repositories_section;
    use uuid::Uuid;

    /// The failure this section was rewritten for: an agent that reads a
    /// capability with no condition attached files it as background and answers
    /// from channel history alone.
    #[test]
    fn the_trigger_comes_before_the_command() {
        let channel = Uuid::new_v4();
        let section = repositories_section(channel);
        let trigger = section
            .find("Before concluding that you cannot answer")
            .expect("the trigger must be present");
        let command = section
            .find("repos list --channel")
            .expect("the command must be present");
        assert!(
            trigger < command,
            "the condition must arrive before the capability: {section}"
        );
    }

    #[test]
    fn the_section_names_the_channel_and_the_command() {
        let channel = Uuid::new_v4();
        let section = repositories_section(channel);
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
        let section = repositories_section(Uuid::new_v4());
        assert!(section.contains("read its README and its root AGENTS.md"));
        assert!(section.contains("Fetch; never pull."));
        assert!(section.contains("404"));
        assert!(section.contains("Projects are a human-side label"));
    }

    /// No list means no staleness and no untrusted content: two channels'
    /// sections differ only by their id.
    /// Filing is the repository's call, not the agent's. If the section were
    /// read as "open a pull request when you finish", every reference
    /// repository would accumulate them.
    #[test]
    fn the_section_defers_the_decision_to_the_repository() {
        let section = repositories_section(Uuid::new_v4());
        assert!(section.contains("buzz pr comments"));
        assert!(section.contains("stated in its own AGENTS.md"));
        assert!(
            section.contains("if it says nothing, do neither"),
            "silence must mean no, or a reference repo collects tasks: {section}"
        );
    }

    /// An agent that guesses a pubkey from a display name tags a stranger as
    /// the reviewer of someone else's work. `<context>` carries the pubkey, so
    /// the section points at it rather than at the name.
    #[test]
    fn the_section_says_where_to_find_the_requester() {
        let section = repositories_section(Uuid::new_v4());
        assert!(section.contains("add whoever asked as a reviewer"));
        assert!(
            section.contains("`Requested by` pubkey from <context>"),
            "must name the field, not the person: {section}"
        );
    }

    /// The trigger only works if it is still near the top. Guarding the length
    /// keeps later additions honest — the first live test failed because a
    /// section read as background.
    #[test]
    fn the_section_stays_short_enough_to_read() {
        let section = repositories_section(Uuid::new_v4());
        let trigger = section.find("Before concluding").expect("trigger present");
        assert!(
            trigger < 120,
            "the trigger must stay in the first lines, found at {trigger}"
        );
        assert!(
            section.len() < 1_800,
            "section is {} bytes; every channel with a repository pays for this",
            section.len()
        );
    }

    #[test]
    fn the_section_interpolates_only_the_channel_id() {
        let channel = Uuid::new_v4();
        let mine = repositories_section(channel).replace(&channel.to_string(), "");
        let nil = repositories_section(Uuid::nil()).replace(&Uuid::nil().to_string(), "");
        assert_eq!(mine, nil);
    }
}
