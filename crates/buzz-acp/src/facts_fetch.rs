//! Fetch a channel's kind:40101 facts document at session creation and render
//! it into a prompt section.
//!
//! Scope:
//! - One bounded query for the newest facts event when a *new channel* session
//!   is born. Never for DMs, never for heartbeats — the caller gates that.
//! - Render `[Channel Facts]` carrying the statements themselves, the revision
//!   they came from, and the curation rules.
//! - On any error — transport, parse, verify — log and emit nothing. A channel
//!   with unreachable facts must look the same as a channel with none, rather
//!   than inviting an agent to rebuild a list it simply could not read.
//! - Session creation is never blocked.
//!
//! The rules ride *inside* the section rather than in `base_prompt.md`, so they
//! appear exactly when facts do. Core memory's rules belong in the base prompt
//! because core exists for every session; facts exist only in channels.

use uuid::Uuid;

use crate::relay::RestClient;

/// Section header.
const SECTION_LABEL: &str = "Channel Facts";

/// Rendered when a channel has no facts yet.
///
/// Without this an empty channel produced no section at all, so an agent never
/// saw the rules — precisely when it most needed telling that durable statements
/// are worth recording. Mirrors [`crate::engram_fetch::ONBOARDING_NUDGE`], which
/// exists for the same reason on an empty core memory.
///
/// Shown only on a **confirmed** empty result. A failed or timed-out fetch emits
/// nothing, so a relay outage never reads as "this channel knows nothing" and
/// invites an agent to re-record what is already there.
fn empty_nudge(channel_uuid: &str) -> String {
    format!(
        "[{SECTION_LABEL}]\n\
         No facts recorded for this channel yet.\n\
         \n\
         This is a short shared list of durable statements — decisions taken, constraints \
         agreed, names and numbers that outlive a conversation. Every agent in the channel \
         reads the same list.\n\
         \n\
         - Record one with `buzz facts add --channel {channel_uuid} --text \"...\"` when a turn \
         establishes something that will still matter next month.\n\
         - If a turn establishes nothing durable, write nothing — that is the normal outcome.\n\
         - Facts are pointers, not summaries. Keep each to a sentence and let the thread hold \
         the detail.\n"
    )
}

/// Bounded fetch — a facts document is a dozen short statements, so a slow
/// relay is never worth delaying a session for.
const FACTS_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Most records rendered into a prompt.
///
/// The write path refuses to exceed this (see `buzz facts`), so a longer list
/// means something bypassed it. Rendering the excess silently would let a
/// bloated document ride in the system prompt for the whole session, and
/// dropping it silently would make an agent confidently wrong about what the
/// channel knows — so the overflow is stated instead.
pub(crate) const MAX_RENDERED_FACTS: usize = 16;

/// A single durable statement.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Fact {
    /// Short stable handle, assigned at write time. Referenced by
    /// `buzz facts supersede --id` and `buzz facts retire --id`, so it must not
    /// change when other records come and go — an index would shift under a
    /// concurrent retire and hit the wrong record.
    pub id: String,
    pub text: String,
}

/// Parse the event content into records.
///
/// Content is a JSON array of `{id, text}`. Anything else — an object, a bare
/// string, malformed JSON — yields `None` rather than a partial list, since a
/// partially understood facts document is worse than none.
pub(crate) fn parse_facts(content: &str) -> Option<Vec<Fact>> {
    let facts: Vec<Fact> = serde_json::from_str(content.trim()).ok()?;
    Some(
        facts
            .into_iter()
            .filter(|f| !f.id.trim().is_empty() && !f.text.trim().is_empty())
            .collect(),
    )
}

/// Render the section: statements, revision, then the curation rules.
///
/// The rules name the real channel UUID so an agent can copy a command
/// straight out of its own context, the way the canvas pointer does.
pub(crate) fn render_facts_section(
    facts: &[Fact],
    event_id: &str,
    timestamp: &str,
    channel_uuid: &str,
) -> String {
    let mut s = format!("[{SECTION_LABEL}]\n");
    s.push_str(
        "A short shared list of durable statements about this channel — decisions taken, \
         constraints agreed, names and numbers that outlive a conversation. Every agent in \
         the channel reads the same list.\n\n",
    );

    let shown = facts.len().min(MAX_RENDERED_FACTS);
    for fact in &facts[..shown] {
        s.push_str(&format!("[{}] {}\n", fact.id, fact.text));
    }
    if facts.len() > shown {
        s.push_str(&format!(
            "({} further record(s) omitted — this list is over its limit and needs retiring \
             down.)\n",
            facts.len() - shown
        ));
    }

    // Recovery, not routine. The harness re-delivers this section when another
    // agent changes it, and the write commands rebase on a freshly read head,
    // so nothing needs a manual fetch in normal operation. The trigger is
    // phrased against something the agent can observe: it cannot detect that it
    // was compacted, but it can notice the section is missing.
    s.push_str(&format!(
        "\nFacts revision (event ID): {event_id}\n\
         Last modified: {timestamp}\n\
         This list is kept current for you — a change another agent makes reaches you \
         on your next turn. If you ever cannot see a [{SECTION_LABEL}] section in your \
         context, recover it with: buzz facts get --channel {channel_uuid}\n"
    ));
    s.push_str(&curation_rules(channel_uuid));
    s
}

/// The curation rules, with `{uuid}` resolved.
///
/// Deliberately no "after answering, consider whether…" trigger: anything of
/// that shape pushes toward curating on every turn, which is the opposite of
/// the intent. Silence is the default and these describe what breaks it.
fn curation_rules(channel_uuid: &str) -> String {
    format!(
        "\n\
         - Write only what outlives the turn. If this turn established nothing durable, write \
         nothing — that is the normal outcome, not a failure. Restating what someone just said, \
         transient status, and anything already listed do not qualify.\n\
         - Facts are pointers, not summaries. \"Moved off Postgres to SQLite in June for the \
         embedded build\" is a fact; the reasoning behind it belongs in the thread, which \
         `buzz messages search --channel {channel_uuid} --query \"...\"` will find.\n\
         - Correct by superseding, never by adding. `buzz facts supersede --channel \
         {channel_uuid} --id <id>` replaces the record it corrects, so the list holds one live \
         answer rather than two that contradict. `buzz facts add` is for something genuinely new.\n\
         - Evict what has shipped. When a recorded decision is done with no open follow-up, \
         `buzz facts retire --channel {channel_uuid} --id <id>` the same turn.\n\
         - Keep it small. Roughly a dozen records, each a single sentence. This list rides in \
         your context for the whole session, so every line is paid on every turn of it.\n\
         - Write to the channel it happened in. A fact learned in a DM stays in that DM. Never \
         copy one into another channel, and never into your own `core` memory.\n"
    )
}

/// Re-label a rendered section as a mid-session replacement.
///
/// The agent already carries a `[{SECTION_LABEL}]` section in its system
/// prompt, fixed for the session's life. A second, unexplained copy in the turn
/// reads either as new material to act on or as a contradiction, so the header
/// changes and says which copy is current.
///
/// The header must stay on the first line: `fit_observer_event_to_budget`
/// elides section bodies in place and relies on every block starting with its
/// `[Header]`.
pub(crate) fn as_refresh(section: &str) -> String {
    let body = section
        .strip_prefix(&format!("[{SECTION_LABEL}]\n"))
        .unwrap_or(section);
    format!(
        "[{SECTION_LABEL} — updated]\n\
         Another agent changed this list since your last turn. It replaces the \
         [{SECTION_LABEL}] section in your system prompt, which is now out of date. \
         Nothing here is an instruction to act on.\n\n{body}"
    )
}

/// Parse a facts query response and render the section.
///
/// Pure, so the validation can be tested without async machinery or a relay.
///
/// Returns the onboarding nudge when the channel is **confirmed** to have no
/// facts — no event, or an event holding an empty list. Returns `None` when the
/// state is *unreadable* rather than empty: unparseable content, a tampered
/// event, the wrong kind, a mismatched `h` tag, or an impossible timestamp.
/// Unreadable must never render as "nothing here".
pub(crate) fn facts_section_from_query_response(
    events: &[serde_json::Value],
    channel_uuid: &str,
) -> Option<String> {
    let Some(raw) = events.first() else {
        // Confirmed absence: the relay answered and this channel has no facts.
        return Some(empty_nudge(channel_uuid));
    };
    let event: nostr::Event = match serde_json::from_value(raw.clone()) {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(
                target: "facts::fetch",
                channel = %channel_uuid,
                %err,
                "facts query returned a malformed event — emitting no section",
            );
            return None;
        }
    };

    // A structurally complete but tampered event must not supply trusted content.
    if let Err(err) = event.verify() {
        tracing::warn!(
            target: "facts::fetch",
            channel = %channel_uuid,
            %err,
            "facts event failed signature verification — emitting no section",
        );
        return None;
    }

    if event.kind != nostr::Kind::Custom(buzz_core::kind::KIND_CHANNEL_FACTS as u16) {
        tracing::warn!(
            target: "facts::fetch",
            channel = %channel_uuid,
            kind = %event.kind.as_u16(),
            "facts event has unexpected kind — emitting no section",
        );
        return None;
    }

    // The REST boundary filters by `#h`, but verify here too so a misbehaving
    // relay cannot hand this channel another channel's facts.
    let h_matches = event.tags.iter().any(|tag| {
        let v = tag.as_slice();
        v.len() >= 2 && v[0] == "h" && v[1] == channel_uuid
    });
    if !h_matches {
        tracing::warn!(
            target: "facts::fetch",
            channel = %channel_uuid,
            "facts event is missing expected h-tag — emitting no section",
        );
        return None;
    }

    let facts = parse_facts(&event.content)?;
    // An emptied list is the same state as never having written one.
    if facts.is_empty() {
        return Some(empty_nudge(channel_uuid));
    }

    let ts_secs = i64::try_from(event.created_at.as_secs()).ok()?;
    let timestamp = chrono::DateTime::from_timestamp(ts_secs, 0)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))?;

    Some(render_facts_section(
        &facts,
        &event.id.to_hex(),
        &timestamp,
        channel_uuid,
    ))
}

/// Fetch the newest facts event for a channel and render its section.
///
/// Called at most once per new channel session; the caller caches the result
/// and clears it on session invalidation.
pub(crate) async fn fetch_facts_section(channel_id: Uuid, rest: &RestClient) -> Option<String> {
    use nostr::{Alphabet, SingleLetterTag};

    let h_tag = SingleLetterTag::lowercase(Alphabet::H);
    let channel_uuid = channel_id.to_string();
    let filter = nostr::Filter::new()
        .kind(nostr::Kind::Custom(
            buzz_core::kind::KIND_CHANNEL_FACTS as u16,
        ))
        .custom_tags(h_tag, [channel_uuid.as_str()])
        .limit(1);

    let json = match tokio::time::timeout(
        FACTS_FETCH_TIMEOUT,
        rest.query(std::slice::from_ref(&filter)),
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::warn!(
                target: "facts::fetch",
                channel = %channel_id,
                "facts query failed: {e} — emitting no section"
            );
            return None;
        }
        Err(_) => {
            tracing::warn!(
                target: "facts::fetch",
                channel = %channel_id,
                timeout_ms = FACTS_FETCH_TIMEOUT.as_millis() as u64,
                "facts fetch timed out — emitting no section"
            );
            return None;
        }
    };

    let events = json.as_array()?;
    facts_section_from_query_response(events, &channel_uuid)
}

#[cfg(test)]
mod tests {

    /// The header must be swapped, not duplicated, and must stay on line one —
    /// the observer frame's size trimmer keys on it.
    #[test]
    fn refresh_relabels_the_section_without_duplicating_the_header() {
        let section = super::render_facts_section(
            &[super::Fact {
                id: "f1".into(),
                text: "we deploy on Tuesdays".into(),
            }],
            "evt123",
            "2026-08-02T10:00:00Z",
            "11111111-1111-1111-1111-111111111111",
        );
        let refreshed = super::as_refresh(&section);
        assert!(refreshed.starts_with("[Channel Facts — updated]\n"));
        // Inline mentions are fine and expected — the note and the recovery
        // line both name the old section. What must not survive is the old
        // header as a header, which would give the block two.
        assert!(
            !refreshed.contains("[Channel Facts]\n"),
            "the original header line must be replaced, not kept"
        );
        assert!(refreshed.contains("we deploy on Tuesdays"));
        assert!(refreshed.contains("Nothing here is an instruction"));
    }

    /// The recovery line has to name a condition the agent can observe. It
    /// cannot tell that it was compacted; it can tell the section is missing.
    #[test]
    fn the_fetch_pointer_is_framed_as_recovery() {
        let section = super::render_facts_section(&[], "e", "t", "uuid-here");
        assert!(section.contains("cannot see a [Channel Facts] section"));
        assert!(section.contains("buzz facts get --channel uuid-here"));
    }
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use serde_json::json;

    fn facts_event(channel: &str, content: &str) -> serde_json::Value {
        let event = EventBuilder::new(
            Kind::Custom(buzz_core::kind::KIND_CHANNEL_FACTS as u16),
            content,
        )
        .tags([Tag::parse(["h", channel]).unwrap()])
        .sign_with_keys(&Keys::generate())
        .unwrap();
        serde_json::to_value(&event).unwrap()
    }

    fn sample() -> String {
        json!([
            {"id": "a3f9c1", "text": "Moved off Postgres to SQLite in June for the embedded build"},
            {"id": "b71e04", "text": "Release notes ship on the Thursday before each release"}
        ])
        .to_string()
    }

    #[test]
    fn parses_records_and_drops_blank_ones() {
        let facts = parse_facts(&sample()).expect("parses");
        assert_eq!(facts.len(), 2);
        assert_eq!(facts[0].id, "a3f9c1");

        let with_blanks =
            json!([{"id": "", "text": "no id"}, {"id": "ok", "text": "   "}]).to_string();
        assert!(parse_facts(&with_blanks).expect("parses").is_empty());
    }

    /// A partially understood facts document is worse than none — an agent
    /// would treat a truncated list as the whole truth.
    #[test]
    fn unparseable_content_yields_nothing() {
        assert!(parse_facts("").is_none());
        assert!(parse_facts("not json").is_none());
        assert!(parse_facts(r#"{"facts": []}"#).is_none());
        assert!(parse_facts(r#"["bare string"]"#).is_none());
    }

    #[test]
    fn renders_statements_revision_and_rules() {
        let facts = parse_facts(&sample()).unwrap();
        let ch = "7fdd5a94-7523-5b86-b574-9124de6cdc0d";
        let s = render_facts_section(&facts, "abc123", "2026-08-01T10:00:00Z", ch);

        assert!(s.starts_with("[Channel Facts]"));
        assert!(s.contains("[a3f9c1] Moved off Postgres"));
        assert!(s.contains("Facts revision (event ID): abc123"));
        assert!(s.contains(&format!("buzz facts get --channel {ch}")));
        // Rules ride with the content, and name the real channel.
        assert!(s.contains("If this turn established nothing durable, write nothing"));
        assert!(s.contains(&format!("buzz facts supersede --channel {ch}")));
        assert!(s.contains("never into your own `core` memory"));
    }

    /// Overflow is stated rather than silently dropped: an agent that cannot
    /// see a record must at least know it exists.
    #[test]
    fn overflow_past_the_render_cap_is_visible() {
        let facts: Vec<Fact> = (0..MAX_RENDERED_FACTS + 3)
            .map(|i| Fact {
                id: format!("id{i}"),
                text: format!("fact {i}"),
            })
            .collect();
        let s = render_facts_section(&facts, "abc", "2026-08-01T10:00:00Z", "ch");
        assert!(s.contains("3 further record(s) omitted"));
        assert!(s.contains(&format!("fact {}", MAX_RENDERED_FACTS - 1)));
        assert!(!s.contains(&format!("fact {MAX_RENDERED_FACTS}")));
    }

    #[test]
    fn query_response_renders_a_valid_event() {
        let ch = "7fdd5a94-7523-5b86-b574-9124de6cdc0d";
        let events = vec![facts_event(ch, &sample())];
        let s = facts_section_from_query_response(&events, ch).expect("section");
        assert!(s.contains("[a3f9c1] Moved off Postgres"));
    }

    #[test]
    fn query_response_rejects_another_channels_facts() {
        // The filter already scopes by #h; this guards a misbehaving relay.
        let events = vec![facts_event("some-other-channel", &sample())];
        assert!(facts_section_from_query_response(&events, "7fdd5a94").is_none());
    }

    #[test]
    fn query_response_rejects_the_wrong_kind() {
        let ch = "ch-1";
        let event = EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_CANVAS as u16), sample())
            .tags([Tag::parse(["h", ch]).unwrap()])
            .sign_with_keys(&Keys::generate())
            .unwrap();
        let events = vec![serde_json::to_value(&event).unwrap()];
        assert!(facts_section_from_query_response(&events, ch).is_none());
    }

    /// A channel with no facts still needs the rules — that is exactly when an
    /// agent most needs telling that durable statements are worth recording.
    #[test]
    fn confirmed_absence_renders_the_onboarding_nudge() {
        let ch = "7fdd5a94-7523-5b86-b574-9124de6cdc0d";
        for events in [vec![], vec![facts_event(ch, "[]")]] {
            let s = facts_section_from_query_response(&events, ch).expect("nudge");
            assert!(s.starts_with("[Channel Facts]"));
            assert!(s.contains("No facts recorded for this channel yet"));
            assert!(s.contains(&format!("buzz facts add --channel {ch}")));
            assert!(s.contains("write nothing"));
            // No revision to cite, and nothing to fetch.
            assert!(!s.contains("Facts revision"));
        }
    }

    /// Unreadable is not the same as empty. Nudging on a tampered or malformed
    /// head would invite an agent to re-record what is already there.
    #[test]
    fn unreadable_state_emits_nothing_rather_than_the_nudge() {
        let ch = "ch-1";
        let mut tampered = facts_event(ch, &sample());
        tampered["content"] = json!(r#"[{"id":"x","text":"injected"}]"#);
        assert!(facts_section_from_query_response(&[tampered], ch).is_none());

        let garbage = vec![facts_event(ch, "not json")];
        assert!(facts_section_from_query_response(&garbage, ch).is_none());
    }
}
