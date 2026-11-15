use std::{collections::BTreeMap, path::PathBuf};

use crate::managed_agents::{
    build_buzz_agent_provider_defaults, default_agent_workdir, known_acp_runtime,
    redact_env_values_in, AgentModelsResponse,
};

use super::agent_models::normalize_agent_models;

pub(super) async fn run_agent_models_command(
    resolved_acp: PathBuf,
    agent_command: String,
    agent_args: Vec<String>,
    persisted_model: Option<String>,
    merged_env: BTreeMap<String, String>,
    probe_model: Option<String>,
    start_model: Option<String>,
) -> Result<AgentModelsResponse, String> {
    // LOCAL DIVERGENCE: start a Claude probe on the model the agent runs, as
    // spawn does (`ANTHROPIC_MODEL`). Claude Code lists some ids, such as
    // `opus[1m]`, only for a session already on them, so a probe on its
    // default would leave the agent's own model out of the catalog.
    let is_claude = is_claude_command(&agent_command);
    let claude_start_model = is_claude
        .then(|| {
            [&probe_model, &start_model]
                .into_iter()
                .flatten()
                .map(|m| m.trim())
                .find(|m| !m.is_empty())
                .map(str::to_string)
        })
        .flatten();
    let spawn_start_model = claude_start_model.clone();
    // Clone the env map for redaction below — `merged_env` is moved
    // into the spawn_blocking closure and we still need the values to
    // scrub any user-supplied secrets that the child surfaces in stderr.
    let env_for_redaction = merged_env.clone();

    // Use spawn_blocking because the desktop Tauri crate doesn't enable
    // tokio's `process` feature. std::process::Command is synchronous
    // but fine for a short-lived subprocess (~2-5s).
    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&resolved_acp);
        if let Some(home) = default_agent_workdir() {
            cmd.current_dir(home);
        }
        // Inject the same augmented PATH used for launched agents and CLI
        // probes: managed Node/npm dirs, exe-parent sidecars, login-shell
        // PATH, and (Windows) the inherited process PATH. login_shell_path()
        // alone is always None on Windows, which left this child with no
        // managed Node dirs — the ACP adapter's `.cmd` shims then failed with
        // `'node' is not recognized` and the model dropdown stayed empty.
        if let Some(ref path) = crate::managed_agents::readiness::cli_probe::augmented_path() {
            cmd.env("PATH", path);
        }
        cmd.arg("models")
            .arg("--json")
            .env("BUZZ_ACP_AGENT_COMMAND", &agent_command)
            .env("BUZZ_ACP_AGENT_ARGS", agent_args.join(","));
        // Selecting a model costs an extra round-trip, so ask only when a
        // caller wants the model-dependent options back.
        if let Some(ref model) = probe_model {
            let model = model.trim();
            if !model.is_empty() {
                cmd.arg("--model").arg(model);
            }
        }
        if let Some(meta) = known_acp_runtime(&agent_command) {
            for (key, value) in meta.default_env {
                if std::env::var(key).is_err() {
                    cmd.env(key, value);
                }
            }
        }
        // Mirror runtime spawn: internal builds may bake provider/model
        // defaults. User-provided env below still wins.
        build_buzz_agent_provider_defaults(&mut cmd);
        // User env layering — written LAST so it overrides any Buzz-set env above.
        for (k, v) in &merged_env {
            cmd.env(k, v);
        }
        if is_claude {
            crate::managed_agents::claude_config::apply_claude_model_env(
                &mut cmd,
                spawn_start_model.as_deref(),
            );
        }
        // Demo identity is authoritative and must win over ambient/user env.
        crate::build_identity::apply_demo_config_home(&mut cmd)?;
        crate::managed_agents::configure_runtime_cli(&mut cmd, known_acp_runtime(&agent_command));
        crate::util::configure_no_window(&mut cmd);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("failed to spawn buzz-acp models: {e}"))
    })
    .await
    .map_err(|e| format!("model discovery task failed: {e}"))?
    .map_err(|e: String| e)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Scrub any user-supplied env values before surfacing stderr to
        // the frontend — persona/agent env_vars may carry API keys that
        // a failing child process echoed back.
        let stderr_redacted = redact_env_values_in(stderr.as_ref(), &env_for_redaction);
        return Err(format!(
            "buzz-acp models failed (exit {}): {stderr_redacted}",
            output.status.code().unwrap_or(-1)
        ));
    }

    let raw: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("failed to parse model JSON: {e}"))?;

    let mut response = normalize_agent_models(&raw, persisted_model);
    if let Some(started) = claude_start_model {
        forget_start_model_as_default(&mut response, &started);
    }
    Ok(response)
}

/// `agent_command` arrives resolved, and on Windows that is the adapter's
/// `.cmd` shim, which `known_acp_runtime` (it strips `.exe` only) misses.
fn is_claude_command(agent_command: &str) -> bool {
    let stem = std::path::Path::new(agent_command)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned());
    [Some(agent_command.to_string()), stem]
        .into_iter()
        .flatten()
        .any(|command| known_acp_runtime(&command).is_some_and(|r| r.id == "claude"))
}

/// A session started on a model reports that model as current, which is not
/// the harness default the "Default model" row describes. Claude Code's own
/// `default` entry is; without one the default is unknown.
fn forget_start_model_as_default(response: &mut AgentModelsResponse, started: &str) {
    if response.agent_default_model.as_deref() == Some(started) {
        response.agent_default_model = response
            .models
            .iter()
            .find(|m| m.id.eq_ignore_ascii_case("default"))
            .map(|m| m.id.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::AgentModelInfo;

    fn response(default: Option<&str>, ids: &[&str]) -> AgentModelsResponse {
        AgentModelsResponse {
            agent_name: "claude".into(),
            agent_version: "1".into(),
            models: ids
                .iter()
                .map(|id| AgentModelInfo {
                    id: id.to_string(),
                    name: None,
                    description: None,
                })
                .collect(),
            agent_default_model: default.map(str::to_string),
            selected_model: None,
            supports_switching: true,
            permission_modes: Vec::new(),
            effort_levels: Vec::new(),
        }
    }

    #[test]
    fn claude_is_recognised_from_a_resolved_windows_shim() {
        assert!(is_claude_command("claude-agent-acp"));
        assert!(is_claude_command(
            r"C:\Users\U\AppData\Roaming\Buzz\node-tools\claude-agent-acp.cmd"
        ));
        assert!(is_claude_command("/usr/local/bin/claude-agent-acp"));
        assert!(!is_claude_command(r"C:\tools\codex-acp.cmd"));
    }

    #[test]
    fn start_model_is_not_reported_as_the_harness_default() {
        let mut started = response(Some("opus[1m]"), &["default", "opus", "opus[1m]"]);
        forget_start_model_as_default(&mut started, "opus[1m]");
        assert_eq!(started.agent_default_model.as_deref(), Some("default"));

        let mut no_default_entry = response(Some("opus[1m]"), &["opus", "opus[1m]"]);
        forget_start_model_as_default(&mut no_default_entry, "opus[1m]");
        assert_eq!(no_default_entry.agent_default_model, None);

        let mut other = response(Some("sonnet"), &["default", "sonnet"]);
        forget_start_model_as_default(&mut other, "opus[1m]");
        assert_eq!(other.agent_default_model.as_deref(), Some("sonnet"));
    }
}
