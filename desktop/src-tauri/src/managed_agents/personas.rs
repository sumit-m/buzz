use std::fs;

use tauri::AppHandle;

use crate::{managed_agents::AgentDefinition, util::now_iso};

struct BuiltInPersona {
    id: &'static str,
    /// Name used when Claude Code is not installed — the agent is harness-
    /// agnostic and inherits whatever the global default resolves to.
    display_name: &'static str,
    /// Name used when Claude Code is installed, matching `claude_model`.
    claude_display_name: &'static str,
    /// Model id as the Claude harness reports it. Seeded only alongside
    /// `RUNTIME_CLAUDE`, never on its own — a Claude model id set against
    /// another provider is not a model that provider has.
    claude_model: &'static str,
    avatar_url: Option<&'static str>,
    default_active: bool,
}

/// The bee persona upstream renamed from Bumble to Pollen.
///
/// This build seeds a Claude-named trio, so nothing here uses these for a
/// built-in. They stay because upstream's one-shot rename migration
/// (`migration/pollen.rs`) reads them to find records seeded before the rename,
/// and those records exist on any profile that ran an older build.
pub(crate) const POLLEN_PERSONA_ID: &str = "builtin:bumble";
pub(crate) const POLLEN_DISPLAY_NAME: &str = "Pollen";
pub(crate) const POLLEN_LEGACY_DISPLAY_NAME: &str = "Bumble";
pub(crate) const POLLEN_SYSTEM_PROMPT: &str = "You are Pollen, a curious and adventurous researcher. Explore questions, compare options, check assumptions, and explain what you find clearly. Be candid when uncertain and favor useful evidence. Add occasional bee wordplay or 🐝🔎—keep it playful, never chaotic.";
pub(crate) const POLLEN_LEGACY_SYSTEM_PROMPT: &str = "You are Bumble, a curious and adventurous researcher. Explore questions, compare options, check assumptions, and explain what you find clearly. Be candid when uncertain and favor useful evidence. Add occasional bee wordplay or 🐝🔎—keep it playful, never chaotic.";

/// Runtime id of the Claude Code harness in `KNOWN_ACP_RUNTIMES`.
const RUNTIME_CLAUDE: &str = "claude";

/// Env var the harness reads its permission mode from.
const PERMISSION_MODE_ENV_KEY: &str = "BUZZ_ACP_PERMISSION_MODE";

/// Permission mode seeded for the Claude variant.
///
/// Without it these agents are mute on arrival. `buzz-acp` defaults to
/// `dontAsk` and denies every `session/request_permission`; the `claude`
/// runtime is given no MCP server, so `base_prompt.md` sends replies through
/// the `buzz` CLI — a Bash call that mode refuses. A freshly seeded agent
/// answers "shell tool access is denied" instead of the greeting.
///
/// `auto` is enough: it lets the CLI run without waiving the permission
/// checkpoint the way `bypassPermissions` would.
const CLAUDE_PERMISSION_MODE: &str = "auto";

/// Env var the harness reads its reasoning-effort level from.
const EFFORT_ENV_KEY: &str = "BUZZ_ACP_EFFORT";

/// Effort level seeded for the Claude variant.
///
/// Unlike the mode this is a preference, not a fix for a broken agent — a
/// mis-seeded mode leaves the trio mute, a mis-seeded effort does not.
///
/// Safe to seed for all three without checking each model's catalog first:
/// `buzz-acp` sends a level only when the *post-model-switch* catalog
/// advertises it (`effort_advertised` in `pool.rs`), so a model that does not
/// offer `high` silently keeps the adapter's default instead of failing the
/// spawn. The dialog's own probe reports what a given model really supports.
const CLAUDE_EFFORT: &str = "high";

// Seeded with no system prompt: an agent's instructions are the user's to
// write. Two naming variants, chosen once when the personas are first seeded
// (see `built_in_persona_records`).
const BUILT_IN_PERSONAS: &[BuiltInPersona] = &[
    BuiltInPersona {
        id: "builtin:fizz",
        display_name: "Fizz",
        claude_display_name: "Opus",
        claude_model: "opus[1m]",
        avatar_url: None,
        default_active: true,
    },
    BuiltInPersona {
        id: "builtin:honey",
        display_name: "Honey",
        claude_display_name: "Sonnet",
        claude_model: "sonnet",
        avatar_url: None,
        default_active: true,
    },
    BuiltInPersona {
        id: "builtin:bumble",
        display_name: "Bumble",
        claude_display_name: "Fable",
        claude_model: "claude-fable-5[1m]",
        avatar_url: None,
        default_active: true,
    },
];

fn built_in_display_name(persona: &BuiltInPersona, claude: bool) -> &'static str {
    if claude {
        persona.claude_display_name
    } else {
        persona.display_name
    }
}

pub(crate) fn built_in_persona_avatar_url(id: &str) -> Option<&'static str> {
    BUILT_IN_PERSONAS
        .iter()
        .find(|persona| persona.id == id)
        .and_then(|persona| persona.avatar_url)
}

const RETIRED_PERSONAS: &[(&str, &str)] = &[
    (
        "builtin:solo",
        "",
    ),
    (
        "builtin:kit",
        "",
    ),
    (
        "builtin:scout",
        "",
    ),
    (
        "builtin:orchestrator",
        "You are an orchestration agent. Coordinate multi-step work across specialized agents, keep the overall plan moving, and synthesize results into a clear final outcome. When another agent should take a task, @mention them explicitly with the assignment, expected deliverable, and any relevant constraints or deadlines.",
    ),
    (
        "builtin:researcher",
        "You are a research agent. Gather relevant information, compare sources, call out uncertainty, and return concise findings with evidence.",
    ),
    (
        "builtin:planner",
        "You are a planning agent. Turn ambiguous requests into structured plans with milestones, dependencies, risks, and clear next actions. Do not implement the work yourself unless asked.",
    ),
    (
        "builtin:implementer",
        "You are a builder agent. Execute tasks directly, make code and configuration changes carefully, validate the result, and explain important decisions and follow-up items.",
    ),
    (
        "builtin:refactor",
        "You are a refactoring agent. Improve structure, naming, duplication, and module boundaries without changing externally observable behavior. Keep changes incremental, preserve compatibility, and add or update validation when behavior could drift.",
    ),
    (
        "builtin:reviewer",
        "You are a review agent. Inspect plans, code, and outputs for bugs, regressions, edge cases, security issues, and missing tests. Prioritize findings by severity, cite concrete evidence, and keep summaries secondary to the actual review.",
    ),
];

/// Build the built-in persona records.
///
/// `claude` selects between the two seed variants: with Claude Code installed
/// each persona is named after the Claude model it is bound to and pinned to
/// that harness; without it they keep their bee names and stay harness-
/// agnostic, inheriting the global default. The harness and model are set
/// together or not at all — a definition's own values win over the global
/// config (`effective_config::resolve_linked`, `effective_agent_command`), so
/// a model without its harness would be handed to whichever provider the
/// default happens to resolve to.
/// Seed env for the built-in personas.
///
/// Both values are claude-agent-acp's own — `auto` exists on no other harness,
/// and effort levels are per-model — so they ride the same set-together rule as
/// the runtime and model: seeded only alongside `RUNTIME_CLAUDE`, never alone.
fn built_in_persona_env(claude: bool) -> std::collections::BTreeMap<String, String> {
    let mut env = std::collections::BTreeMap::new();
    if claude {
        env.insert(
            PERMISSION_MODE_ENV_KEY.to_string(),
            CLAUDE_PERMISSION_MODE.to_string(),
        );
        env.insert(EFFORT_ENV_KEY.to_string(), CLAUDE_EFFORT.to_string());
    }
    env
}

fn built_in_persona_records(now: &str, claude: bool) -> Vec<AgentDefinition> {
    BUILT_IN_PERSONAS
        .iter()
        .map(|persona| AgentDefinition {
            id: persona.id.to_string(),
            display_name: built_in_display_name(persona, claude).to_string(),
            avatar_url: persona.avatar_url.map(|s| s.to_string()),
            description: None,
            system_prompt: String::new(),
            acp_command: None,
            runtime: claude.then(|| RUNTIME_CLAUDE.to_string()),
            model: claude.then(|| persona.claude_model.to_string()),
            provider: None,
            name_pool: vec![built_in_display_name(persona, claude).to_string()],
            is_builtin: true,
            is_active: persona.default_active,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            team_catalog_source: None,
            env_vars: built_in_persona_env(claude),
            respond_to: None,
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            session_policy: super::AcpSessionPolicy::Channel,
            created_at: now.to_string(),
            updated_at: now.to_string(),
        })
        .collect()
}

/// Which trio to seed: the harness the user *chose*, and only that.
///
/// Onboarding asks for a default harness and offers "Skip for now". Skipping
/// discards the draft, so no choice reaches disk — and an installed Claude Code
/// used to fill that silence, seeding Opus, Sonnet and Fable for someone who had
/// just declined to pick Claude. Installing a harness is not choosing one. With
/// no choice recorded the bee names are seeded instead: they pin no harness and
/// no model, so they follow whatever default is set later.
///
/// Ordering is what makes the choice answerable here. `MachineBootstrap` renders
/// the community flow only once machine onboarding — identity, harness, defaults
/// — has completed, and the first persona load is the Welcome Team intro inside
/// that flow. The answer is on disk before anything asks.
pub(crate) fn seeds_claude_variant<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    seeds_claude_variant_for(
        crate::managed_agents::global_config::load_global_agent_config(app)
            .ok()
            .and_then(|config| config.preferred_runtime)
            .as_deref(),
    )
}

fn seeds_claude_variant_for(preferred_runtime: Option<&str>) -> bool {
    preferred_runtime == Some(RUNTIME_CLAUDE)
}

pub(crate) fn built_in_persona_definition(id: &str, now: &str) -> Option<AgentDefinition> {
    built_in_persona_records(now, super::discovery::claude_harness_available())
        .into_iter()
        .find(|persona| persona.id == id)
}

fn built_in_order(id: &str) -> Option<usize> {
    BUILT_IN_PERSONAS
        .iter()
        .position(|persona| persona.id == id)
}

fn sort_personas(records: &mut [AgentDefinition]) {
    records.sort_by(|left, right| {
        let left_builtin = if left.is_builtin { 0 } else { 1 };
        let right_builtin = if right.is_builtin { 0 } else { 1 };

        left_builtin
            .cmp(&right_builtin)
            .then_with(
                || match (built_in_order(&left.id), built_in_order(&right.id)) {
                    (Some(left_order), Some(right_order)) => left_order.cmp(&right_order),
                    _ => std::cmp::Ordering::Equal,
                },
            )
            .then_with(|| {
                left.display_name
                    .to_lowercase()
                    .cmp(&right.display_name.to_lowercase())
            })
            .then_with(|| left.id.cmp(&right.id))
    });
}

/// `claude_variant` decides which of the two name sets is seeded, and is
/// called at most once — only when a built-in is actually missing. `load_personas`
/// runs on many hot paths, and answering it can read the global config or spawn
/// a login shell through `resolve_command` on a cold cache; every later load
/// finds all three present and never asks.
fn merge_personas(
    mut stored: Vec<AgentDefinition>,
    now: &str,
    claude_variant: impl FnOnce() -> bool,
) -> (Vec<AgentDefinition>, bool) {
    let mut changed = false;

    let seeding = BUILT_IN_PERSONAS
        .iter()
        .any(|built_in| !stored.iter().any(|record| record.id == built_in.id));
    let claude = seeding && claude_variant();

    for built_in in built_in_persona_records(now, claude) {
        if let Some(existing) = stored.iter_mut().find(|record| record.id == built_in.id) {
            if !existing.is_builtin {
                existing.is_builtin = true;
                changed = true;
            }
        } else {
            stored.push(built_in);
            changed = true;
        }
    }

    // Demote any stored persona still flagged as built-in whose id is no
    // longer in BUILT_IN_PERSONAS (e.g. a built-in that has been retired).
    // The record stays so existing managed-agent and team references keep
    // working; the user can delete it from the catalog like any custom
    // persona once they no longer need it.
    for record in stored.iter_mut() {
        if record.is_builtin && built_in_order(&record.id).is_none() {
            record.is_builtin = false;
            record.updated_at = now.to_string();
            changed = true;
        }
    }

    // Soft-deprecate retired built-in personas that were replaced by
    // Fizz. Runs after demotion so the records are already
    // marked as non-builtin.
    if migrate_retired_personas(&mut stored, now) {
        changed = true;
    }

    sort_personas(&mut stored);
    (stored, changed)
}

/// Soft-deprecate retired built-in personas by appending " (retired)" to
/// their display name and marking them inactive. Never removes records —
/// the cost is extra records for pre-transition users, but this
/// eliminates dangling `persona_id` references in managed-agents.json
/// and teams.json.
fn migrate_retired_personas(stored: &mut [AgentDefinition], now: &str) -> bool {
    let mut changed = false;

    for record in stored.iter_mut() {
        if let Some((_, original_prompt)) = RETIRED_PERSONAS.iter().find(|(id, _)| *id == record.id)
        {
            let retired_suffix = " (retired)";
            let needs_suffix = !record.display_name.ends_with(retired_suffix);
            if needs_suffix || record.is_active {
                let was_unmodified = record.system_prompt == *original_prompt;
                eprintln!(
                    "buzz-desktop: persona-migration: retiring {} persona '{}' → '{} (retired)'",
                    if was_unmodified {
                        "unmodified"
                    } else {
                        "customized"
                    },
                    record.display_name,
                    record.display_name,
                );
                if needs_suffix {
                    record.display_name = format!("{}{}", record.display_name, retired_suffix);
                }
                record.is_active = false;
                record.updated_at = now.to_string();
                changed = true;
            }
        }
    }

    changed
}

pub fn ensure_persona_is_active(
    personas: &[AgentDefinition],
    persona_id: &str,
) -> Result<(), String> {
    let persona = personas
        .iter()
        .find(|candidate| candidate.id == persona_id)
        .ok_or_else(|| format!("agent {persona_id} not found"))?;

    if !persona.is_active {
        return Err(format!("{} is not in My Agents.", persona.display_name));
    }

    Ok(())
}

pub fn ensure_persona_ids_are_active(
    personas: &[AgentDefinition],
    persona_ids: &[String],
) -> Result<(), String> {
    for persona_id in persona_ids {
        ensure_persona_is_active(personas, persona_id)?;
    }

    Ok(())
}

pub fn validate_persona_deletion(
    persona: &AgentDefinition,
    referenced_by_team: bool,
) -> Result<(), String> {
    if persona.is_builtin {
        return Err("Built-in agents cannot be deleted.".to_string());
    }

    if persona.source_team.is_some() {
        return Err(format!(
            "{} belongs to a team. Delete the team to remove all team agents together.",
            persona.display_name
        ));
    }

    if referenced_by_team {
        return Err(format!(
            "{} is still referenced by a team. Remove it from those teams first.",
            persona.display_name
        ));
    }

    Ok(())
}

pub fn validate_persona_activation_change(
    persona: &AgentDefinition,
    active: bool,
    referenced_by_managed_agent: bool,
    referenced_by_team: bool,
) -> Result<(), String> {
    if !persona.is_builtin {
        return Err("Only built-in agents can be added to or removed from My Agents.".to_string());
    }

    if !active && referenced_by_managed_agent {
        return Err(format!(
            "{} is still assigned to a managed agent. Remove or reassign those agents first.",
            persona.display_name
        ));
    }

    if !active && referenced_by_team {
        return Err(format!(
            "{} is still referenced by a team. Remove it from those teams first.",
            persona.display_name
        ));
    }

    Ok(())
}

pub fn load_personas<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<AgentDefinition>, String> {
    let now = now_iso();

    // Post-fold: definitions live in the unified agent store, presented in
    // the legacy shape. Pre-fold stores are converted by
    // `fold_personas_into_agent_store` in boot migrations before any caller
    // reaches this shim.
    let records = crate::managed_agents::storage::load_agent_definitions(app)?
        .iter()
        .filter_map(|record| record.to_definition_view())
        .collect();

    let (records, changed) = merge_personas(records, &now, || seeds_claude_variant(app));
    if changed {
        save_personas(app, &records)?;
    }

    Ok(records)
}

/// Definitions exactly as stored — no built-in merge, and so no write-back.
///
/// For readers that only *render* the current set rather than act on it.
/// Seeding is a write, and `load_personas` performs it on first read: a
/// renderer calling that on a cold first launch decides which trio the user
/// gets roughly a second into boot, long before onboarding has asked them which
/// harness they want. `regenerate_nest_context` is exactly such a reader — it
/// paints AGENTS.md with whatever agents exist, and "none yet" is a truthful
/// answer during onboarding.
pub fn load_personas_unseeded<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<AgentDefinition>, String> {
    Ok(crate::managed_agents::storage::load_agent_definitions(app)?
        .iter()
        .filter_map(|record| record.to_definition_view())
        .collect())
}

/// Read the raw persona records at `path` — no built-in merge, no write-back.
/// The single disk-read seam for persona definitions: `load_personas` layers
/// the built-in merge on top, and the boot-time readers that need raw records
/// without an `AppHandle` (`event_sync`, `migration::load_persona_runtimes`)
/// call it directly. The A2 store fold retargets THIS function at the unified
/// store; its callers stay unchanged.
pub(crate) fn load_personas_from_path(
    path: &std::path::Path,
) -> Result<Vec<AgentDefinition>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("failed to read persona store: {error}"))?;
    serde_json::from_str::<Vec<AgentDefinition>>(&content)
        .map_err(|error| format!("failed to parse persona store: {error}"))
}

pub fn save_personas<R: tauri::Runtime>(
    app: &AppHandle<R>,
    records: &[AgentDefinition],
) -> Result<(), String> {
    let mut sorted = records.to_vec();
    sort_personas(&mut sorted);

    // Post-fold: persona saves write key-less definition records into the
    // unified agent store (instances preserved by `save_agent_definitions`).
    let definitions: Vec<_> = sorted
        .into_iter()
        .map(|persona| persona.into_agent_record())
        .collect();
    crate::managed_agents::storage::save_agent_definitions(app, &definitions)
}

#[cfg(test)]
mod tests;
