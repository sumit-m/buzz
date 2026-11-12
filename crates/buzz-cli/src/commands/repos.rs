use buzz_core::{
    git_perms::{parse_protection_tag, parse_protection_tags, RefPattern},
    kind::{KIND_GIT_REPO_ANNOUNCEMENT, KIND_GIT_REPO_STATE},
};
use nostr::{Event, EventBuilder, Tag, Timestamp};

use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;
use crate::validate::validate_repo_id;

fn parse_events(json: &str) -> Result<Vec<Event>, CliError> {
    serde_json::from_str(json)
        .map_err(|error| CliError::Other(format!("failed to parse relay response: {error}")))
}

pub(crate) async fn fetch_own_repo_announcement(
    client: &BuzzClient,
    repo_id: &str,
) -> Result<Option<Event>, CliError> {
    let filter = serde_json::json!({
        "kinds": [KIND_GIT_REPO_ANNOUNCEMENT],
        "authors": [client.public_key().to_hex()],
        "#d": [repo_id],
        "limit": 1,
    });
    let raw = client.query(&filter).await?;
    let mut events = parse_events(&raw)?;
    events.sort_by_key(|event| std::cmp::Reverse(event.created_at));
    Ok(events.into_iter().next())
}

fn repo_id_from_event(event: &Event) -> Result<&str, CliError> {
    event
        .tags
        .iter()
        .find_map(|tag| {
            let values = tag.as_slice();
            (values.first().map(String::as_str) == Some("d"))
                .then(|| values.get(1).map(String::as_str))
                .flatten()
        })
        .ok_or_else(|| CliError::Other("repository announcement is missing its d tag".into()))
}

fn tag_error(error: impl std::fmt::Display) -> CliError {
    CliError::Other(format!("failed to build protection tag: {error}"))
}

fn protection_pattern(tag: &Tag) -> Option<&str> {
    let values = tag.as_slice();
    (values.first().map(String::as_str) == Some("buzz-protect"))
        .then(|| values.get(1).map(String::as_str))
        .flatten()
}

fn has_tag_name(tag: &Tag, name: &str) -> bool {
    tag.as_slice().first().map(String::as_str) == Some(name)
}

fn build_protection_tag(
    ref_pattern: &str,
    push_role: Option<&str>,
    no_force_push: bool,
    no_delete: bool,
    require_patch: bool,
) -> Result<Tag, CliError> {
    let mut values = vec!["buzz-protect".to_string(), ref_pattern.to_string()];
    if let Some(role) = push_role {
        values.push(format!("push:{role}"));
    }
    if no_force_push {
        values.push("no-force-push".into());
    }
    if no_delete {
        values.push("no-delete".into());
    }
    if require_patch {
        values.push("require-patch".into());
    }
    let rule_values: Vec<&str> = values[1..].iter().map(String::as_str).collect();
    parse_protection_tag(&rule_values)
        .map_err(|error| CliError::Usage(format!("invalid protection rule: {error}")))?;
    Tag::parse(values).map_err(tag_error)
}

enum RepoChange {
    SetProtection(Box<Tag>),
    RemoveProtection(String),
    /// Bind (or rebind) the repo to a channel: replaces every existing
    /// `buzz-channel` tag with exactly one carrying the validated UUID.
    BindChannel(String),
}

fn build_updated_repo_announcement(
    existing: &Event,
    change: RepoChange,
) -> Result<EventBuilder, CliError> {
    let repo_id = repo_id_from_event(existing)?;
    // What to strip beyond `auth` (always stripped), and what to append.
    let (removed_pattern, removed_channel, replacement) = match change {
        RepoChange::SetProtection(tag) => {
            let pattern = protection_pattern(&tag)
                .ok_or_else(|| CliError::Other("replacement is not a protection tag".into()))?
                .to_string();
            (Some(pattern), false, Some(*tag))
        }
        RepoChange::RemoveProtection(pattern) => {
            RefPattern::parse(&pattern)
                .map_err(|error| CliError::Usage(format!("invalid ref pattern: {error}")))?;
            (Some(pattern), false, None)
        }
        RepoChange::BindChannel(channel) => {
            crate::validate::validate_uuid(&channel)?;
            let tag = Tag::parse(["buzz-channel", channel.as_str()]).map_err(tag_error)?;
            (None, true, Some(tag))
        }
    };

    let mut tags: Vec<Tag> = existing
        .tags
        .iter()
        .filter(|tag| {
            if has_tag_name(tag, "auth") {
                return false;
            }
            if removed_channel && has_tag_name(tag, "buzz-channel") {
                return false;
            }
            removed_pattern.is_none() || protection_pattern(tag) != removed_pattern.as_deref()
        })
        .cloned()
        .collect();
    if let Some(tag) = replacement {
        tags.push(tag);
    }

    let raw_tags: Vec<Vec<String>> = tags.iter().map(|tag| tag.as_slice().to_vec()).collect();
    parse_protection_tags(&raw_tags).map_err(|error| {
        CliError::Other(format!(
            "repository contains invalid protection rules; refusing update: {error}"
        ))
    })?;

    // Advance only the observed head. Using wall-clock time here would let a
    // delayed writer leapfrog an intervening update and silently erase metadata.
    let next_created_at = existing
        .created_at
        .as_secs()
        .checked_add(1)
        .ok_or_else(|| CliError::Other("repository timestamp cannot be advanced".into()))?;
    buzz_sdk::build_repo_announcement_with_tags(repo_id, &existing.content, tags)
        .map_err(|error| CliError::Other(format!("failed to build repository update: {error}")))
        .map(|builder| builder.custom_created_at(Timestamp::from(next_created_at)))
}

fn protection_rules_json(event: &Event) -> Result<serde_json::Value, CliError> {
    let raw_tags: Vec<Vec<String>> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    let (unknown_rules, validation_error) = match parse_protection_tags(&raw_tags) {
        Ok(parsed) => (parsed.unknown_rules, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    let protections: Vec<serde_json::Value> = event
        .tags
        .iter()
        .filter_map(|tag| {
            let values = tag.as_slice();
            (values.first().map(String::as_str) == Some("buzz-protect")).then(|| {
                serde_json::json!({
                    "ref": values.get(1).map(String::as_str).unwrap_or(""),
                    "rules": values.get(2..).unwrap_or_default(),
                })
            })
        })
        .collect();

    Ok(serde_json::json!({
        "repo_id": repo_id_from_event(event)?,
        "protections": protections,
        "unknown_rules": unknown_rules,
        "validation_error": validation_error,
    }))
}

fn validate_write_response(raw: &str) -> Result<String, CliError> {
    parse_write_response(
        raw,
        "repository changed concurrently; fetch the latest rules and retry",
    )
}

async fn submit_repo_update(client: &BuzzClient, builder: EventBuilder) -> Result<(), CliError> {
    let event = client.sign_event(builder).await?;
    let raw = client.submit_event(event).await?;
    println!("{}", validate_write_response(&raw)?);
    Ok(())
}

/// Build the kind:30617 announcement for `repos create`, including the
/// `buzz-channel` binding when requested.
///
/// Pure (no I/O) so the emitted tags are unit-testable. Exactly one
/// validated `buzz-channel` tag is appended — the tag is the git ACL
/// (issue #3527: without it the relay 404s every clone/fetch/push), so the
/// UUID is shape-validated here and its existence/membership is the relay's
/// authority at git-access time, same posture as `repos bind`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_create_announcement(
    repo_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    clone_urls: &[String],
    web_url: Option<&str>,
    relays: &[String],
    channel: Option<&str>,
) -> Result<EventBuilder, CliError> {
    validate_repo_id(repo_id)?;

    let clone_refs: Vec<&str> = clone_urls.iter().map(|s| s.as_str()).collect();
    let relay_refs: Vec<&str> = relays.iter().map(|s| s.as_str()).collect();

    let mut builder = buzz_sdk::build_repo_announcement(
        repo_id,
        name,
        description,
        &clone_refs,
        web_url,
        &relay_refs,
    )
    .map_err(|e| CliError::Other(format!("build_repo_announcement failed: {e}")))?;

    if let Some(channel) = channel {
        crate::validate::validate_uuid(channel)?;
        builder = builder.tag(Tag::parse(["buzz-channel", channel]).map_err(tag_error)?);
    }
    Ok(builder)
}

#[allow(clippy::too_many_arguments)]
pub async fn cmd_create_repo(
    client: &BuzzClient,
    repo_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    clone_urls: &[String],
    web_url: Option<&str>,
    relays: &[String],
    channel: Option<&str>,
) -> Result<(), CliError> {
    let builder = build_create_announcement(
        repo_id,
        name,
        description,
        clone_urls,
        web_url,
        relays,
        channel,
    )?;
    let event = client.sign_event(builder).await?;
    let owner = event.pubkey.to_hex();
    let resp = client.submit_event(event).await?;
    // `link` renders as a rich preview card in Buzz Desktop when included in
    // a chat message — agents announce repos with it (see base_prompt.md).
    let link = crate::links::repo_link(&owner, repo_id);
    crate::client::print_create_response(&resp, "link", &link);
    if let Some(channel) = channel {
        // Best-effort: a repo announced into a project home channel should
        // join that project instead of rendering as a second project card.
        let _ = crate::commands::projects::try_add_own_repo_to_channel_project(
            client, channel, repo_id,
        )
        .await;
    }
    Ok(())
}

pub async fn cmd_get_repo(
    client: &BuzzClient,
    repo_id: &str,
    owner: Option<&str>,
) -> Result<(), CliError> {
    validate_repo_id(repo_id)?;

    let mut filter = serde_json::json!({
        "kinds": [30617],
        "#d": [repo_id]
    });

    // If owner specified, filter by author pubkey; otherwise return any match.
    // Note: without --owner, multiple repos with the same name (different owners) may be returned.
    if let Some(pk) = owner {
        crate::validate::validate_hex64(pk)?;
        filter["authors"] = serde_json::json!([pk]);
    }

    let resp = client.query(&filter).await?;
    println!("{resp}");
    Ok(())
}

pub async fn cmd_list_repos(
    client: &BuzzClient,
    owner: Option<&str>,
    channel: Option<&str>,
    limit: Option<u32>,
    repos_dir: Option<&str>,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    let filter = build_repo_list_filter(owner, channel, limit, &client.public_key().to_hex())?;

    let resp = client.query(&filter).await?;
    let output = match format {
        crate::OutputFormat::Compact => {
            let events: Vec<serde_json::Value> = serde_json::from_str(&resp).unwrap_or_default();
            let root = crate::repos_root::resolve_repos_root(repos_dir);
            let compact: Vec<serde_json::Value> = events
                .iter()
                .filter_map(|event| compact_repo(event, root.as_deref(), client.relay_url()))
                .collect();
            serde_json::to_string(&compact).unwrap_or_default()
        }
        crate::OutputFormat::Json | crate::OutputFormat::Agent => resp,
    };
    println!("{output}");
    if let Some(note) = empty_listing_note(owner, channel, &output) {
        eprintln!("{note}");
    }
    Ok(())
}

/// The one-line warning that turns a misleading empty listing into a
/// self-correcting one, or `None` when the result is unambiguous.
///
/// With neither `--owner` nor `--channel`, the listing is scoped to the
/// caller's own repositories — and an agent owns none, so it gets `[]`. That
/// empty array reads as "this channel has no repositories" and has twice made
/// an agent tell a human nothing was written down while a bound repository
/// held the answer. The note goes to **stderr** so stdout stays exactly the
/// JSON a caller parses.
fn empty_listing_note(owner: Option<&str>, channel: Option<&str>, output: &str) -> Option<String> {
    if owner.is_some() || channel.is_some() {
        return None;
    }
    let empty = matches!(output.trim(), "[]" | "");
    empty.then(|| {
        "note: this listed only repositories you own, and you own none. It is not a \
         channel's repositories — for that, pass `--channel <uuid>`."
            .to_string()
    })
}

/// Build the relay filter for `repos list`.
///
/// `channel` becomes the `#buzz-channel` raw-filter extension — the relay pushes
/// it down to a JSONB containment on the announcement's `buzz-channel` tag, which
/// is the same tag the git ACL reads. Scoping by it means every result is a
/// repository the caller can actually clone.
///
/// With no `channel` the owner default stands (self, unless `--owner` names
/// someone). With a channel and no owner the listing is channel-wide, which is
/// the point: an agent asking what it can work on does not know who owns what.
fn build_repo_list_filter(
    owner: Option<&str>,
    channel: Option<&str>,
    limit: Option<u32>,
    self_pubkey: &str,
) -> Result<serde_json::Value, CliError> {
    let mut filter = serde_json::json!({ "kinds": [30617] });

    if let Some(channel_id) = channel {
        crate::validate::validate_uuid(channel_id)?;
        filter["#buzz-channel"] = serde_json::json!([channel_id]);
    }

    match owner {
        Some(pk) => {
            crate::validate::validate_hex64(pk)?;
            filter["authors"] = serde_json::json!([pk]);
        }
        // Only default to self when nothing else narrows the query — a
        // channel-scoped listing that silently added `authors:[self]` would
        // return nothing for the common case of a repository someone else owns.
        None if channel.is_none() => {
            filter["authors"] = serde_json::json!([self_pubkey]);
        }
        None => {}
    }

    if let Some(n) = limit {
        filter["limit"] = serde_json::json!(n);
    }
    Ok(filter)
}

/// Project one kind:30617 announcement to the fields an agent needs to act:
/// what to call it, how to address it, where to clone it from, and which branch.
///
/// `checkout` is filesystem state rather than relay state: the local path when
/// a checkout exists, `null` otherwise. It is what tells an agent whether to
/// clone or to read what is already on disk.
fn compact_repo(
    event: &serde_json::Value,
    repos_root: Option<&std::path::Path>,
    relay_url: &str,
) -> Option<serde_json::Value> {
    let tags = event.get("tags")?.as_array()?;
    let tag_value = |name: &str| -> Option<String> {
        tags.iter().find_map(|tag| {
            let parts = tag.as_array()?;
            (parts.first()?.as_str()? == name)
                .then(|| parts.get(1)?.as_str().map(String::from))
                .flatten()
        })
    };
    let tag_values = |name: &str| -> Vec<String> {
        tags.iter()
            .filter_map(|tag| {
                let parts = tag.as_array()?;
                (parts.first()?.as_str()? == name)
                    .then(|| parts.get(1)?.as_str().map(String::from))
                    .flatten()
            })
            .collect()
    };

    let id = tag_value("d")?;
    let owner = event.get("pubkey")?.as_str()?.to_string();
    let clone_url =
        effective_clone_url(tag_values("clone").first().cloned(), relay_url, &owner, &id);
    let checkout = repos_root.and_then(|root| {
        crate::repos_root::find_checkout(root, &id, clone_url.as_deref())
            .map(|path| path.display().to_string())
    });
    Some(serde_json::json!({
        "id": id,
        "name": tag_value("name"),
        "coordinate": format!("30617:{owner}:{id}"),
        "owner": owner,
        "clone": clone_url,
        // NIP-34 leaves the default branch out of the announcement; Buzz mirrors
        // Desktop's read model, which falls back to `main`.
        "branch": tag_value("default-branch").unwrap_or_else(|| "main".to_string()),
        "channel": tag_value("buzz-channel"),
        "checkout": checkout,
    }))
}

async fn current_repo(client: &BuzzClient, repo_id: &str) -> Result<Event, CliError> {
    validate_repo_id(repo_id)?;
    fetch_own_repo_announcement(client, repo_id)
        .await?
        .ok_or_else(|| {
            CliError::NotFound(format!(
                "repository {repo_id:?} was not found for the current identity"
            ))
        })
}

async fn cmd_protect_list(client: &BuzzClient, repo_id: &str) -> Result<(), CliError> {
    let event = current_repo(client, repo_id).await?;
    println!("{}", protection_rules_json(&event)?);
    Ok(())
}

async fn cmd_protect_set(
    client: &BuzzClient,
    repo_id: &str,
    ref_pattern: &str,
    push_role: Option<crate::RepoPushRole>,
    no_force_push: bool,
    no_delete: bool,
    require_patch: bool,
) -> Result<(), CliError> {
    let push_role = push_role.map(|role| match role {
        crate::RepoPushRole::Owner => "owner",
        crate::RepoPushRole::Admin => "admin",
        crate::RepoPushRole::Member => "member",
    });
    let tag = build_protection_tag(
        ref_pattern,
        push_role,
        no_force_push,
        no_delete,
        require_patch,
    )?;
    let event = current_repo(client, repo_id).await?;
    let builder =
        build_updated_repo_announcement(&event, RepoChange::SetProtection(Box::new(tag)))?;
    submit_repo_update(client, builder).await
}

async fn cmd_protect_remove(
    client: &BuzzClient,
    repo_id: &str,
    ref_pattern: &str,
) -> Result<(), CliError> {
    RefPattern::parse(ref_pattern)
        .map_err(|error| CliError::Usage(format!("invalid ref pattern: {error}")))?;
    let event = current_repo(client, repo_id).await?;
    if !event
        .tags
        .iter()
        .any(|tag| protection_pattern(tag) == Some(ref_pattern))
    {
        return Err(CliError::NotFound(format!(
            "repository {repo_id:?} has no protection rule for {ref_pattern:?}"
        )));
    }
    let builder = build_updated_repo_announcement(
        &event,
        RepoChange::RemoveProtection(ref_pattern.to_string()),
    )?;
    submit_repo_update(client, builder).await
}

/// Bind (or rebind) a repository to a channel — the fix path for issue
/// #3527's permanently-404 repos. Publishes a read-modify-write update of
/// the caller's own kind:30617 with exactly one `buzz-channel` tag; all
/// other metadata (protections, name, description, future tags) is
/// preserved by the same machinery `repos protect` uses.
///
/// The UUID is validated for *shape* only — deliberately. Channel existence
/// and the caller's membership are the relay's authority at git-access
/// time; a CLI-side network pre-check would just be TOCTOU with extra
/// latency.
async fn cmd_bind_repo(client: &BuzzClient, repo_id: &str, channel: &str) -> Result<(), CliError> {
    let event = current_repo(client, repo_id).await?;
    let builder =
        build_updated_repo_announcement(&event, RepoChange::BindChannel(channel.to_string()))?;
    submit_repo_update(client, builder).await
}

pub async fn dispatch(
    cmd: crate::ReposCmd,
    client: &BuzzClient,
    format: &crate::OutputFormat,
) -> Result<(), CliError> {
    use crate::{ReposCmd, ReposProtectCmd};
    match cmd {
        ReposCmd::Create {
            id,
            name,
            description,
            clone_urls,
            web,
            relays,
            channel,
        } => {
            cmd_create_repo(
                client,
                &id,
                name.as_deref(),
                description.as_deref(),
                &clone_urls,
                web.as_deref(),
                &relays,
                channel.as_deref(),
            )
            .await
        }
        ReposCmd::Get { id, owner } => cmd_get_repo(client, &id, owner.as_deref()).await,
        ReposCmd::List {
            owner,
            channel,
            limit,
            repos_dir,
        } => {
            cmd_list_repos(
                client,
                owner.as_deref(),
                channel.as_deref(),
                limit,
                repos_dir.as_deref(),
                format,
            )
            .await
        }
        ReposCmd::State { id, owner } => cmd_repo_state(client, &id, owner.as_deref()).await,
        ReposCmd::Clone {
            id,
            owner,
            repos_dir,
        } => cmd_clone_repo(client, &id, owner.as_deref(), repos_dir.as_deref()).await,
        ReposCmd::Bind { id, channel } => cmd_bind_repo(client, &id, &channel).await,
        ReposCmd::DefaultBranch(command) => {
            super::repo_default_branch::dispatch(command, client).await
        }
        ReposCmd::Protect(command) => match command {
            ReposProtectCmd::List { id } => cmd_protect_list(client, &id).await,
            ReposProtectCmd::Set {
                id,
                ref_pattern,
                push,
                no_force_push,
                no_delete,
                require_patch,
            } => {
                cmd_protect_set(
                    client,
                    &id,
                    &ref_pattern,
                    push,
                    no_force_push,
                    no_delete,
                    require_patch,
                )
                .await
            }
            ReposProtectCmd::Remove { id, ref_pattern } => {
                cmd_protect_remove(client, &id, &ref_pattern).await
            }
        },
    }
}

/// Fetch the newest announcement for a repository coordinate.
///
/// `owner` defaults to the caller, matching `repos get`. An agent working in a
/// channel usually passes the owner it read from `repos list --channel`.
/// Split `30617:<owner>:<id>` into its parts, or pass a bare id through.
///
/// `repos list` prints a `coordinate` for every repository, and it is the only
/// output that carries the owner. Accepting it wherever an id is accepted means
/// an agent can hand back exactly what the listing gave it. Without this, the
/// id alone defaults the lookup to the caller's own pubkey, so a channel
/// repository owned by anyone else reports "not found" — which reads as an
/// access problem and is not one.
fn parse_repo_ref(input: &str) -> (String, Option<String>) {
    let mut parts = input.splitn(3, ':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("30617"), Some(owner), Some(id)) if !owner.is_empty() && !id.is_empty() => {
            (id.to_string(), Some(owner.to_string()))
        }
        _ => (input.to_string(), None),
    }
}

/// The URL to clone from: the announced one when there is one, else the
/// relay-hosted default.
///
/// Buzz relays serve their own repositories at `<relay>/git/<owner>/<id>`, and
/// `buzz repos create` publishes no `clone` tag, so an announcement without one
/// is the normal case rather than a broken repository. Desktop already derives
/// the same URL for the same reason — see
/// `desktop/src/features/projects/lib/projectCloneUrl.ts`.
///
/// An explicit tag always wins: NIP-34 allows pointing `clone` at another host,
/// and overriding that would silently clone the wrong repository.
fn effective_clone_url(
    announced: Option<String>,
    relay_url: &str,
    owner: &str,
    repo_id: &str,
) -> Option<String> {
    if announced.is_some() {
        return announced;
    }
    // Only a 64-hex owner addresses a relay-hosted repository; anything else is
    // not ours to guess at.
    if crate::validate::validate_hex64(owner).is_err() {
        return None;
    }
    let origin = crate::client::normalize_relay_url(relay_url);
    Some(format!(
        "{origin}/git/{}/{repo_id}",
        owner.to_ascii_lowercase()
    ))
}

async fn fetch_repo_announcement(
    client: &BuzzClient,
    repo_id: &str,
    owner: Option<&str>,
) -> Result<Event, CliError> {
    validate_repo_id(repo_id)?;
    let author = match owner {
        Some(pk) => {
            crate::validate::validate_hex64(pk)?;
            pk.to_string()
        }
        None => client.public_key().to_hex(),
    };
    let filter = serde_json::json!({
        "kinds": [KIND_GIT_REPO_ANNOUNCEMENT],
        "authors": [author],
        "#d": [repo_id],
        "limit": 1,
    });
    let raw = client.query(&filter).await?;
    let mut events = parse_events(&raw)?;
    events.sort_by_key(|event| std::cmp::Reverse(event.created_at));
    events.into_iter().next().ok_or_else(|| {
        CliError::NotFound(format!(
            "repository {repo_id:?} was not found. If someone told you it exists, \
             you are probably not a member of the channel it is bound to — ask to \
             be added rather than retrying."
        ))
    })
}

fn first_tag_value<'a>(event: &'a Event, name: &str) -> Option<&'a str> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 2 && parts[0] == name).then(|| parts[1].as_str())
    })
}

/// `buzz repos state` — the relay's own view of a repository's refs.
///
/// The relay signs a kind:30618 after every push, so this answers "has the
/// remote moved?" with one query: no git request, no repository hydration, and
/// no checkout required.
pub async fn cmd_repo_state(
    client: &BuzzClient,
    repo_id: &str,
    owner: Option<&str>,
) -> Result<(), CliError> {
    let (repo_id, coordinate_owner) = parse_repo_ref(repo_id);
    let repo_id = repo_id.as_str();
    validate_repo_id(repo_id)?;
    if let Some(pk) = owner.or(coordinate_owner.as_deref()) {
        crate::validate::validate_hex64(pk)?;
    }
    // No `authors`: the **relay** signs kind:30618, not the repository's owner,
    // so filtering by any user pubkey matches nothing and the command reports
    // "no ref state published" for every repository that has one. The `p` tag
    // is no better a filter — it carries the *pusher*, so scoping to the owner
    // would hide a member's push, which is the change this command exists to
    // notice. `d` plus newest-wins is what identifies the state.
    let filter = serde_json::json!({
        "kinds": [KIND_GIT_REPO_STATE],
        "#d": [repo_id],
        "limit": 8,
    });
    let raw = client.query(&filter).await?;
    let mut events = parse_events(&raw)?;
    events.sort_by_key(|event| std::cmp::Reverse(event.created_at));
    let Some(event) = events.into_iter().next() else {
        return Err(CliError::NotFound(format!(
            "no ref state published for repository {repo_id:?} — it may have no commits yet"
        )));
    };
    println!("{}", repo_state_json(&event));
    Ok(())
}

/// Project a kind:30618 to `{ ref: oid }` plus HEAD.
///
/// NIP-34 puts each ref in its own tag; a flat map is what a caller actually
/// compares against what it saw last.
fn repo_state_json(event: &Event) -> serde_json::Value {
    let mut refs = serde_json::Map::new();
    let mut head = None;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.len() < 2 {
            continue;
        }
        match parts[0].as_str() {
            "HEAD" => head = Some(parts[1].clone()),
            name if name.starts_with("refs/") => {
                refs.insert(name.to_string(), serde_json::json!(parts[1]));
            }
            _ => {}
        }
    }
    serde_json::json!({
        "head": head,
        "refs": refs,
        "created_at": event.created_at.as_secs(),
    })
}

/// `buzz repos clone` — clone a repository into the local checkout root, ready
/// to commit from.
///
/// Exists as a command rather than prompt prose because of step 4: an agent is
/// told to stop and ask when a repository's git identity is empty, which is
/// exactly a fresh clone's state. Cloning by hand therefore produces an agent
/// that clones and then refuses to commit. Setting identity here removes the
/// stall structurally.
pub async fn cmd_clone_repo(
    client: &BuzzClient,
    repo_id: &str,
    owner: Option<&str>,
    repos_dir: Option<&str>,
) -> Result<(), CliError> {
    let (repo_id, coordinate_owner) = parse_repo_ref(repo_id);
    let repo_id = repo_id.as_str();
    let owner = owner.or(coordinate_owner.as_deref());
    let event = fetch_repo_announcement(client, repo_id, owner).await?;
    let announced = first_tag_value(&event, "clone").map(String::from);
    let clone_url = effective_clone_url(
        announced,
        client.relay_url(),
        &event.pubkey.to_hex(),
        repo_id,
    )
    .ok_or_else(|| {
        CliError::Other(format!(
            "repository {repo_id:?} publishes no clone URL, so there is nothing to clone"
        ))
    })?;
    let clone_url = clone_url.as_str();

    let root = crate::repos_root::resolve_repos_root(repos_dir)
        .ok_or_else(|| CliError::Other("could not resolve a repository root".to_string()))?;
    let name = crate::repos_root::local_repo_candidates(repo_id, Some(clone_url))
        .into_iter()
        .next()
        .ok_or_else(|| {
            CliError::Usage(format!("repository id {repo_id:?} is not a directory name"))
        })?;
    let destination = root.join(&name);

    if destination.exists() {
        return Err(CliError::Other(format!(
            "{} already exists — work in it rather than cloning again",
            destination.display()
        )));
    }
    std::fs::create_dir_all(&root).map_err(|error| {
        CliError::Other(format!("could not create {}: {error}", root.display()))
    })?;

    run_git(&[
        "clone",
        clone_url,
        destination
            .to_str()
            .ok_or_else(|| CliError::Other("destination path is not valid UTF-8".to_string()))?,
    ])?;

    // Repo-local, never global: every local agent shares one working directory,
    // so a global write would attribute the other agents' commits to this one.
    let pubkey = client.public_key().to_hex();
    let destination_str = destination.to_string_lossy().to_string();
    // Derived, never configured: an agent's commits must be attributable to the
    // agent, or the git trail disagrees with the pubkey trail.
    let identity_name = format!("buzz-{}", &pubkey[..8]);
    run_git(&[
        "-C",
        &destination_str,
        "config",
        "user.name",
        &identity_name,
    ])?;
    run_git(&[
        "-C",
        &destination_str,
        "config",
        "user.email",
        &format!("{pubkey}@users.noreply.buzz"),
    ])?;

    println!(
        "{}",
        serde_json::json!({
            "id": repo_id,
            "path": destination_str,
            "clone": clone_url,
        })
    );
    Ok(())
}

/// Run git, mapping a failure to the CLI's error vocabulary.
///
/// Auth is inherited from the environment: Buzz Desktop already sets
/// `GIT_CONFIG_*` for `git-credential-nostr` plus `NOSTR_PRIVATE_KEY` when it
/// spawns an agent, so a clone of a relay-hosted repository authenticates with
/// no work here.
fn run_git(args: &[&str]) -> Result<String, CliError> {
    let output = std::process::Command::new("git")
        .args(args)
        .output()
        .map_err(|error| CliError::Other(format!("could not run git: {error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // A relay 404 is not "no such repository" — it is "you are not in the
        // channel this repository is bound to". Say so, because the difference
        // decides whether retrying is pointless.
        if stderr.contains("404") || stderr.to_lowercase().contains("not found") {
            return Err(CliError::NotFound(
                "the relay returned 404. For a Buzz-hosted repository that means you are \
                 not a member of the channel it is bound to — ask to be added rather than \
                 retrying."
                    .to_string(),
            ));
        }
        return Err(CliError::Other(format!(
            "git {:?} failed: {stderr}",
            args[0]
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    use super::{
        build_create_announcement, build_protection_tag, build_repo_list_filter,
        build_updated_repo_announcement, compact_repo, effective_clone_url, empty_listing_note,
        parse_repo_ref, protection_rules_json, validate_write_response, RepoChange,
    };

    fn signed_repo(tags: Vec<Tag>, content: &str, created_at: u64) -> nostr::Event {
        EventBuilder::new(Kind::Custom(30617), content)
            .tags(tags)
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(&Keys::generate())
            .expect("sign repository event")
    }

    fn tag(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).expect("valid test tag")
    }

    #[test]
    fn protection_update_preserves_metadata_and_replaces_only_matching_pattern() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["name", "Demo"]),
                tag(&["buzz-channel", "channel-id"]),
                tag(&["future-metadata", "preserve-me"]),
                tag(&["auth", &"a".repeat(64), "kind=30617", &"b".repeat(128)]),
                tag(&["buzz-protect", "refs/heads/main", "push:member"]),
                tag(&["buzz-protect", "refs/tags/*", "no-delete"]),
            ],
            "repository content",
            100,
        );
        let replacement = build_protection_tag("refs/heads/main", Some("admin"), true, true, false)
            .expect("valid replacement");

        let updated = build_updated_repo_announcement(
            &existing,
            RepoChange::SetProtection(Box::new(replacement)),
        )
        .expect("build update")
        .sign_with_keys(&Keys::generate())
        .expect("sign update");

        assert_eq!(updated.content, "repository content");
        assert_eq!(updated.created_at.as_secs(), 101);
        assert!(!updated
            .tags
            .iter()
            .any(|tag| tag.as_slice().first().map(String::as_str) == Some("auth")));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["buzz-channel", "channel-id"]));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["future-metadata", "preserve-me"]));
        assert!(updated.tags.iter().any(|tag| {
            tag.as_slice()
                == [
                    "buzz-protect",
                    "refs/heads/main",
                    "push:admin",
                    "no-force-push",
                    "no-delete",
                ]
        }));
        assert!(updated
            .tags
            .iter()
            .any(|tag| { tag.as_slice() == ["buzz-protect", "refs/tags/*", "no-delete"] }));
        assert_eq!(
            updated
                .tags
                .iter()
                .filter(|tag| {
                    let values = tag.as_slice();
                    values.first().map(String::as_str) == Some("buzz-protect")
                        && values.get(1).map(String::as_str) == Some("refs/heads/main")
                })
                .count(),
            1
        );
    }

    #[test]
    fn protection_remove_preserves_other_patterns() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["buzz-protect", "refs/heads/main", "no-delete"]),
                tag(&["buzz-protect", "refs/heads/release", "push:owner"]),
            ],
            "",
            10,
        );

        let updated = build_updated_repo_announcement(
            &existing,
            RepoChange::RemoveProtection("refs/heads/main".into()),
        )
        .expect("build removal")
        .sign_with_keys(&Keys::generate())
        .expect("sign removal");

        assert!(!updated
            .tags
            .iter()
            .any(|tag| tag.as_slice().get(1).map(String::as_str) == Some("refs/heads/main")));
        assert!(updated
            .tags
            .iter()
            .any(|tag| { tag.as_slice() == ["buzz-protect", "refs/heads/release", "push:owner"] }));
    }

    #[test]
    fn protection_set_requires_at_least_one_rule() {
        assert!(build_protection_tag("refs/heads/main", None, false, false, false).is_err());
    }

    #[test]
    fn protection_update_rejects_malformed_existing_rules() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["buzz-protect", "refs/heads/main"]),
            ],
            "",
            10,
        );
        let replacement =
            build_protection_tag("refs/heads/release", Some("admin"), false, false, false)
                .expect("valid replacement");

        let error = build_updated_repo_announcement(
            &existing,
            RepoChange::SetProtection(Box::new(replacement)),
        )
        .expect_err("malformed existing rule must fail closed");

        assert!(error
            .to_string()
            .contains("repository contains invalid protection rules"));
    }

    #[test]
    fn protection_update_enforces_repository_rule_limit() {
        let mut tags = vec![tag(&["d", "demo"])];
        for index in 0..50 {
            tags.push(tag(&[
                "buzz-protect",
                &format!("refs/heads/branch-{index}"),
                "push:member",
            ]));
        }
        let existing = signed_repo(tags, "", 10);
        let replacement =
            build_protection_tag("refs/heads/main", Some("admin"), false, false, false)
                .expect("valid replacement");

        let error = build_updated_repo_announcement(
            &existing,
            RepoChange::SetProtection(Box::new(replacement)),
        )
        .expect_err("the 51st rule must be rejected");

        assert!(error.to_string().contains("exceeds max 50"));
    }

    #[test]
    fn protection_list_keeps_unknown_rules_visible() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&[
                    "buzz-protect",
                    "refs/heads/main",
                    "push:admin",
                    "future-rule",
                ]),
            ],
            "",
            10,
        );

        let json = protection_rules_json(&existing).expect("list protections");
        assert_eq!(json["repo_id"], "demo");
        assert_eq!(json["protections"][0]["ref"], "refs/heads/main");
        assert_eq!(
            json["protections"][0]["rules"],
            serde_json::json!(["push:admin", "future-rule"])
        );
        assert_eq!(json["validation_error"], serde_json::Value::Null);
    }

    #[test]
    fn protection_list_surfaces_malformed_rules_for_recovery() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["buzz-protect", "refs/heads/main"]),
            ],
            "",
            10,
        );

        let json = protection_rules_json(&existing).expect("list malformed protections");
        assert_eq!(json["protections"][0]["ref"], "refs/heads/main");
        assert!(json["validation_error"]
            .as_str()
            .is_some_and(|error| error.contains("needs pattern + at least one rule")));
    }

    #[test]
    fn bind_channel_replaces_duplicates_and_preserves_everything_else() {
        let channel = uuid::Uuid::new_v4().to_string();
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["name", "Demo"]),
                // Two stale bindings — e.g. from a buggy or vanilla client.
                tag(&["buzz-channel", "old-and-broken"]),
                tag(&["buzz-channel", &uuid::Uuid::new_v4().to_string()]),
                tag(&["auth", &"a".repeat(64), "kind=30617", &"b".repeat(128)]),
                tag(&["buzz-protect", "refs/heads/main", "push:admin"]),
                tag(&["future-metadata", "preserve-me"]),
            ],
            "repository content",
            100,
        );

        let updated =
            build_updated_repo_announcement(&existing, RepoChange::BindChannel(channel.clone()))
                .expect("build bind update")
                .sign_with_keys(&Keys::generate())
                .expect("sign bind update");

        assert_eq!(updated.content, "repository content");
        assert_eq!(updated.created_at.as_secs(), 101);
        // Exactly one binding remains, and it is the requested one.
        let bindings: Vec<_> = updated
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("buzz-channel"))
            .collect();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].as_slice(), ["buzz-channel", channel.as_str()]);
        // Auth stripped (relay re-stamps); everything else preserved.
        assert!(!updated
            .tags
            .iter()
            .any(|tag| tag.as_slice().first().map(String::as_str) == Some("auth")));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["buzz-protect", "refs/heads/main", "push:admin"]));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["future-metadata", "preserve-me"]));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["name", "Demo"]));
    }

    #[test]
    fn bind_channel_adds_binding_to_unbound_repo() {
        let channel = uuid::Uuid::new_v4().to_string();
        let existing = signed_repo(vec![tag(&["d", "demo"])], "", 10);

        let updated =
            build_updated_repo_announcement(&existing, RepoChange::BindChannel(channel.clone()))
                .expect("build bind update")
                .sign_with_keys(&Keys::generate())
                .expect("sign bind update");

        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["buzz-channel", channel.as_str()]));
    }

    #[test]
    fn bind_channel_rejects_malformed_uuid() {
        let existing = signed_repo(vec![tag(&["d", "demo"])], "", 10);

        let error =
            build_updated_repo_announcement(&existing, RepoChange::BindChannel("nope".into()))
                .expect_err("malformed channel id must not build an update");

        assert!(matches!(error, crate::error::CliError::Usage(_)));
    }

    /// Issue #3527: `repos create --channel` must emit exactly one
    /// `buzz-channel` tag so the primary create command stops producing
    /// repos the relay 404s forever.
    #[test]
    fn create_with_channel_emits_exactly_one_binding_tag() {
        let channel = uuid::Uuid::new_v4().to_string();
        let event = build_create_announcement(
            "demo",
            Some("Demo"),
            None,
            &["https://relay.example/git/owner/demo".to_string()],
            None,
            &[],
            Some(&channel),
        )
        .expect("build create announcement")
        .sign_with_keys(&Keys::generate())
        .expect("sign create announcement");

        assert_eq!(event.kind, Kind::Custom(30617));
        let bindings: Vec<_> = event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("buzz-channel"))
            .collect();
        assert_eq!(bindings.len(), 1, "exactly one buzz-channel tag");
        assert_eq!(bindings[0].as_slice(), ["buzz-channel", channel.as_str()]);
        // The standard metadata still rides along.
        assert!(event.tags.iter().any(|tag| tag.as_slice() == ["d", "demo"]));
        assert!(event
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["name", "Demo"]));
    }

    #[test]
    fn create_without_channel_emits_no_binding_tag() {
        let event = build_create_announcement("demo", None, None, &[], None, &[], None)
            .expect("build create announcement")
            .sign_with_keys(&Keys::generate())
            .expect("sign create announcement");

        assert!(
            !event
                .tags
                .iter()
                .any(|tag| tag.as_slice().first().map(String::as_str) == Some("buzz-channel")),
            "no --channel means no binding tag (vanilla NIP-34 stays possible)"
        );
    }

    #[test]
    fn create_rejects_malformed_channel_uuid() {
        let error = build_create_announcement("demo", None, None, &[], None, &[], Some("nope"))
            .expect_err("malformed channel id must not build an announcement");
        assert!(matches!(error, crate::error::CliError::Usage(_)));
    }

    #[test]
    fn duplicate_write_response_is_a_conflict() {
        let error = validate_write_response(
            r#"{"event_id":"abc","accepted":true,"message":"duplicate: superseded"}"#,
        )
        .expect_err("dominated writes must not report success");

        assert!(matches!(error, crate::error::CliError::Conflict(_)));
    }

    #[test]
    fn successful_write_response_is_normalized() {
        let output = validate_write_response(
            r#"{"event_id":"abc","accepted":true,"message":"saved","extra":"ignored"}"#,
        )
        .expect("accepted write");

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&output).expect("normalized JSON"),
            serde_json::json!({
                "event_id": "abc",
                "accepted": true,
                "message": "saved",
            })
        );
    }
    // ── repos list --channel ──────────────────────────────────────────────────

    const SELF_PK: &str = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
    const OTHER_PK: &str = "11aa22bb33cc44dd55ee66ff11aa22bb33cc44dd55ee66ff11aa22bb33cc44dd";
    const CHANNEL: &str = "0b3a4bd2-4d4a-4a0e-9c3f-1f2d3e4a5b6c";
    const RELAY: &str = "http://127.0.0.1:3000";

    #[test]
    fn list_without_channel_still_defaults_to_self() {
        let filter = build_repo_list_filter(None, None, None, SELF_PK).unwrap();
        assert_eq!(filter["authors"], serde_json::json!([SELF_PK]));
        assert!(filter.get("#buzz-channel").is_none());
    }

    /// The load-bearing case: an agent asking what it can work on does not know
    /// who owns what, so a channel listing must not silently narrow to self.
    #[test]
    fn channel_listing_is_not_scoped_to_the_caller() {
        let filter = build_repo_list_filter(None, Some(CHANNEL), None, SELF_PK).unwrap();
        assert_eq!(filter["#buzz-channel"], serde_json::json!([CHANNEL]));
        assert!(
            filter.get("authors").is_none(),
            "a channel-scoped listing must not add authors:[self]"
        );
    }

    #[test]
    fn owner_and_channel_intersect() {
        let filter =
            build_repo_list_filter(Some(OTHER_PK), Some(CHANNEL), Some(5), SELF_PK).unwrap();
        assert_eq!(filter["authors"], serde_json::json!([OTHER_PK]));
        assert_eq!(filter["#buzz-channel"], serde_json::json!([CHANNEL]));
        assert_eq!(filter["limit"], serde_json::json!(5));
    }

    #[test]
    fn malformed_channel_is_rejected_before_the_relay_sees_it() {
        assert!(build_repo_list_filter(None, Some("not-a-uuid"), None, SELF_PK).is_err());
    }

    #[test]
    fn compact_projection_carries_what_an_agent_needs() {
        let event = serde_json::json!({
            "pubkey": OTHER_PK,
            "tags": [
                ["d", "bee-garden"],
                ["name", "Bee Garden"],
                ["clone", "http://127.0.0.1:3000/git/owner/bee-garden"],
                ["buzz-channel", CHANNEL],
            ],
        });
        let compact = compact_repo(&event, None, RELAY).expect("projection");
        assert_eq!(compact["id"], serde_json::json!("bee-garden"));
        assert_eq!(
            compact["coordinate"],
            serde_json::json!(format!("30617:{OTHER_PK}:bee-garden"))
        );
        assert_eq!(
            compact["clone"],
            serde_json::json!("http://127.0.0.1:3000/git/owner/bee-garden")
        );
        assert_eq!(compact["channel"], serde_json::json!(CHANNEL));
        // NIP-34 announcements carry no default branch; Desktop's read model
        // falls back to main and so does this.
        assert_eq!(compact["branch"], serde_json::json!("main"));
    }

    #[test]
    fn compact_projection_prefers_a_declared_default_branch() {
        let event = serde_json::json!({
            "pubkey": OTHER_PK,
            "tags": [["d", "repo"], ["default-branch", "trunk"]],
        });
        let compact = compact_repo(&event, None, RELAY).expect("projection");
        assert_eq!(compact["branch"], serde_json::json!("trunk"));
    }

    /// An announcement with no `d` tag is malformed; skip it rather than
    /// emitting a row with no way to address the repository.
    #[test]
    fn compact_projection_skips_an_unaddressable_announcement() {
        let event = serde_json::json!({ "pubkey": OTHER_PK, "tags": [["name", "no d tag"]] });
        assert!(compact_repo(&event, None, RELAY).is_none());
    }

    /// An unscoped empty listing is the one result that lies: it means "you
    /// own no repositories", and it has twice been read as "this channel has
    /// none".
    #[test]
    fn an_unscoped_empty_listing_says_what_it_actually_searched() {
        let note = empty_listing_note(None, None, "[]").expect("note");
        assert!(note.contains("only repositories you own"));
        assert!(note.contains("--channel"));
    }

    /// A scoped listing means what it says, and a listing with results needs
    /// no explaining — neither may be second-guessed with a warning.
    #[test]
    fn a_scoped_or_non_empty_listing_gets_no_note() {
        assert!(empty_listing_note(None, Some(CHANNEL), "[]").is_none());
        assert!(empty_listing_note(Some(OTHER_PK), None, "[]").is_none());
        assert!(empty_listing_note(None, None, r#"[{"id":"bee-garden"}]"#).is_none());
    }

    /// The failure this fixes: every announcement Buzz writes omits `clone`,
    /// so an agent asked to clone a channel's repository was told there was
    /// nothing to clone — of a repository that had commits.
    #[test]
    fn a_repository_with_no_clone_tag_still_reports_where_to_clone_from() {
        let event = serde_json::json!({
            "pubkey": OTHER_PK,
            "tags": [["d", "bee-garden"], ["buzz-channel", CHANNEL]],
        });
        let compact = compact_repo(&event, None, RELAY).expect("projection");
        assert_eq!(
            compact["clone"],
            serde_json::json!(format!("{RELAY}/git/{OTHER_PK}/bee-garden"))
        );
    }

    /// NIP-34 permits pointing `clone` at another host, so an announced URL
    /// must never be replaced by the relay-hosted guess.
    #[test]
    fn an_announced_clone_url_wins_over_the_derived_one() {
        let announced = Some("https://github.com/someone/mirror.git".to_string());
        assert_eq!(
            effective_clone_url(announced.clone(), RELAY, OTHER_PK, "mirror"),
            announced
        );
    }

    /// A pubkey that cannot address a relay-hosted repository yields no guess.
    #[test]
    fn a_malformed_owner_produces_no_derived_url() {
        assert!(effective_clone_url(None, RELAY, "not-a-pubkey", "repo").is_none());
    }

    /// `repos list` prints the coordinate and nothing else carries the owner,
    /// so handing it straight back to `clone` or `state` has to work — a bare
    /// id defaults the lookup to the caller and misses everyone else's repos.
    #[test]
    fn a_coordinate_supplies_the_owner_a_bare_id_lacks() {
        assert_eq!(
            parse_repo_ref(&format!("30617:{OTHER_PK}:bee-garden")),
            ("bee-garden".to_string(), Some(OTHER_PK.to_string()))
        );
        assert_eq!(
            parse_repo_ref("bee-garden"),
            ("bee-garden".to_string(), None)
        );
        // Not a repository coordinate: leave it alone rather than shredding it.
        assert_eq!(
            parse_repo_ref("30023:pubkey:article"),
            ("30023:pubkey:article".to_string(), None)
        );
    }

    /// `checkout` is what tells an agent whether to clone or read what is
    /// already on disk, so it must reflect the filesystem, not the relay.
    #[test]
    fn compact_projection_reports_an_existing_checkout() {
        let root = tempfile::tempdir().expect("temp root");
        std::fs::create_dir_all(root.path().join("bee-garden").join(".git"))
            .expect("fake checkout");
        let event = serde_json::json!({
            "pubkey": OTHER_PK,
            "tags": [
                ["d", "bee-garden"],
                ["clone", "http://127.0.0.1:3000/git/owner/bee-garden"],
            ],
        });

        let cloned = compact_repo(&event, Some(root.path()), RELAY).expect("projection");
        assert!(
            cloned["checkout"]
                .as_str()
                .is_some_and(|path| path.ends_with("bee-garden")),
            "an existing checkout must be reported: {cloned}"
        );

        let absent = serde_json::json!({
            "pubkey": OTHER_PK,
            "tags": [["d", "not-cloned"]],
        });
        let absent = compact_repo(&absent, Some(root.path()), RELAY).expect("projection");
        assert!(
            absent["checkout"].is_null(),
            "a repository with no checkout must report null"
        );
    }
    // ── repos state ───────────────────────────────────────────────────────────

    #[test]
    fn repo_state_flattens_refs_and_head() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::Custom(30618), "")
            .tags(vec![
                Tag::parse(["d", "bee-garden"]).unwrap(),
                Tag::parse(["HEAD", "ref: refs/heads/main"]).unwrap(),
                Tag::parse(["refs/heads/main", "a".repeat(40).as_str()]).unwrap(),
                Tag::parse(["refs/tags/v1", "b".repeat(40).as_str()]).unwrap(),
            ])
            .sign_with_keys(&keys)
            .expect("sign state");

        let json = super::repo_state_json(&event);
        assert_eq!(json["head"], serde_json::json!("ref: refs/heads/main"));
        assert_eq!(
            json["refs"]["refs/heads/main"],
            serde_json::json!("a".repeat(40))
        );
        assert_eq!(
            json["refs"]["refs/tags/v1"],
            serde_json::json!("b".repeat(40))
        );
        // The d tag identifies the repository; it is not a ref.
        assert!(json["refs"].get("d").is_none());
    }

    /// A repository with no pushes yet publishes a state event with no refs.
    /// That is "nothing to compare", not an error.
    #[test]
    fn repo_state_survives_an_empty_repository() {
        let keys = Keys::generate();
        let event = EventBuilder::new(Kind::Custom(30618), "")
            .tags(vec![Tag::parse(["d", "empty"]).unwrap()])
            .sign_with_keys(&keys)
            .expect("sign state");
        let json = super::repo_state_json(&event);
        assert!(json["head"].is_null());
        assert_eq!(json["refs"], serde_json::json!({}));
    }
}
