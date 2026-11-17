//! LOCAL DIVERGENCE: message-box controls a custom harness declares.
//!
//! A harness file in `<app-data>/custom_harnesses/` may carry a `composer`
//! block: a mode toggle and a few controls (model, aspect, ...) that the
//! Desktop renders in the message box when the user mentions an agent on that
//! harness. The picks travel to the agent as a hidden message tag; the harness
//! maps them to its own CLI.
//!
//! Read beside, not through, `HarnessDefinition`: the block is parsed from the
//! same files, but only for harnesses `load_custom_harnesses` accepts, so a
//! file the catalog rejects never contributes controls.
//!
//! A block may name `refresh` arguments: before each read of the panels, the
//! harness's own command runs with them (bounded, no window), with
//! `BUZZ_HARNESS_FILE` naming its file, so it can rewrite its controls from
//! its own settings first (mage: presets from `presets.ini`).
//!
//! Limitation: editing a custom harness in Settings rewrites its file from
//! `HarnessDefinition`, which drops the `composer` block. Its installer (for
//! mage, `install.ps1`) writes it back.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::custom_harnesses::load_custom_harnesses;

const MAX_MODES: usize = 3;
const MAX_CONTROLS: usize = 8;
const MAX_OPTIONS: usize = 50;
const MAX_TEXT: usize = 64;
const MAX_REFRESH_ARGS: usize = 4;
const REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSpec {
    #[serde(default)]
    pub modes: Vec<ComposerMode>,
    #[serde(default)]
    pub controls: Vec<ComposerControl>,
    /// Arguments for the harness command that rewrites this block before
    /// each read (see the module docs).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refresh: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerMode {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub requires_image: bool,
    #[serde(default)]
    pub auto_on_image: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerControl {
    pub id: String,
    /// `list`, `shapes`, `segmented`, `preset` or `repoFolder`. Other kinds are
    /// kept and ignored by the renderer, so a newer file still loads.
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub default_by_mode: BTreeMap<String, String>,
    #[serde(default)]
    pub options: Vec<ComposerOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_folder: Option<String>,
    /// The key in an image's `.json` sidecar that holds this control's value,
    /// so "Edit" on an image can start from the settings that made it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidecar_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(from = "RawOption")]
#[serde(rename_all = "camelCase")]
pub struct ComposerOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[u32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<u32>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sets: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modes: Vec<String>,
}

/// An option may be written as a bare string (`"1K"`) or as an object.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawOption {
    Plain(String),
    Full {
        value: String,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        size: Option<[u32; 2]>,
        #[serde(default)]
        scale: Option<u32>,
        #[serde(default)]
        sets: BTreeMap<String, String>,
        #[serde(default)]
        modes: Vec<String>,
    },
}

impl From<RawOption> for ComposerOption {
    fn from(raw: RawOption) -> Self {
        match raw {
            RawOption::Plain(value) => ComposerOption {
                label: value.clone(),
                value,
                size: None,
                scale: None,
                sets: BTreeMap::new(),
                modes: Vec::new(),
            },
            RawOption::Full {
                value,
                label,
                size,
                scale,
                sets,
                modes,
            } => ComposerOption {
                label: label.unwrap_or_else(|| value.clone()),
                value,
                size,
                scale,
                sets,
                modes,
            },
        }
    }
}

/// A harness's controls, with what the Desktop needs to match it to an agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessComposer {
    pub harness_id: String,
    pub command: String,
    pub composer: ComposerSpec,
}

fn is_id(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_TEXT
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn check_text(what: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > MAX_TEXT {
        return Err(format!("{what} must be 1-{MAX_TEXT} characters"));
    }
    Ok(())
}

pub(crate) fn validate(spec: &ComposerSpec) -> Result<(), String> {
    if spec.modes.len() > MAX_MODES {
        return Err(format!("at most {MAX_MODES} modes"));
    }
    if spec.controls.len() > MAX_CONTROLS {
        return Err(format!("at most {MAX_CONTROLS} controls"));
    }
    if spec.refresh.len() > MAX_REFRESH_ARGS
        || spec
            .refresh
            .iter()
            .any(|arg| arg.is_empty() || arg.len() > MAX_TEXT || arg.chars().any(char::is_control))
    {
        return Err(format!(
            "refresh takes at most {MAX_REFRESH_ARGS} arguments of 1-{MAX_TEXT} characters"
        ));
    }
    let mut mode_ids = HashSet::new();
    for mode in &spec.modes {
        if !is_id(&mode.id) || !mode_ids.insert(mode.id.as_str()) {
            return Err(format!("mode id {:?} is invalid or repeated", mode.id));
        }
        check_text("mode label", &mode.label)?;
    }
    let control_ids: HashSet<&str> = spec.controls.iter().map(|c| c.id.as_str()).collect();
    if control_ids.len() != spec.controls.len() {
        return Err("control ids must be unique".into());
    }
    for control in &spec.controls {
        if !is_id(&control.id) {
            return Err(format!("control id {:?} is invalid", control.id));
        }
        check_text("control label", &control.label)?;
        if let Some(key) = &control.sidecar_key {
            if !is_id(key) {
                return Err(format!("{}: sidecarKey {key:?} is invalid", control.id));
            }
        }
        if control.options.len() > MAX_OPTIONS {
            return Err(format!("{}: at most {MAX_OPTIONS} options", control.id));
        }
        for mode in control.default_by_mode.keys() {
            if !mode_ids.contains(mode.as_str()) {
                return Err(format!(
                    "{}: defaultByMode names unknown mode {mode:?}",
                    control.id
                ));
            }
        }
        for option in &control.options {
            check_text("option label", &option.label)?;
            if option.value.is_empty()
                || option.value.len() > MAX_TEXT
                || option
                    .value
                    .chars()
                    .any(|c| c.is_whitespace() || c == '"' || c == '\'')
            {
                return Err(format!(
                    "{}: option value {:?} is invalid",
                    control.id, option.value
                ));
            }
            if let Some(key) = option
                .sets
                .keys()
                .find(|k| !control_ids.contains(k.as_str()))
            {
                return Err(format!(
                    "{}: preset sets unknown control {key:?}",
                    control.id
                ));
            }
            if let Some(mode) = option.modes.iter().find(|m| !mode_ids.contains(m.as_str())) {
                return Err(format!(
                    "{}: option names unknown mode {mode:?}",
                    control.id
                ));
            }
        }
    }
    Ok(())
}

/// Controls declared by the custom harnesses in `dir`, for harnesses the
/// catalog loader accepts and whose `composer` block validates.
pub(crate) fn load_harness_composers(dir: &Path) -> Vec<HarnessComposer> {
    load_harness_composers_with(dir, run_refresh)
}

/// Runs `command args` for at most [`REFRESH_TIMEOUT`], ignoring the outcome:
/// a harness that fails to refresh keeps the panel it has.
fn run_refresh(command: &str, args: &[String], harness_file: &Path) {
    let mut cmd = std::process::Command::new(command);
    cmd.args(args).env("BUZZ_HARNESS_FILE", harness_file);
    match super::discovery::bounded_command::output_with_timeout(cmd, REFRESH_TIMEOUT) {
        Some(output) if output.status.success() => {}
        Some(output) => tracing::warn!(
            "custom_harnesses: {command} refresh exited with {}",
            output.status
        ),
        None => tracing::warn!("custom_harnesses: {command} refresh failed or timed out"),
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(text.trim_start_matches('\u{feff}')).ok())
}

fn load_harness_composers_with(
    dir: &Path,
    refresh: impl Fn(&str, &[String], &Path),
) -> Vec<HarnessComposer> {
    let accepted: HashMap<String, String> = load_custom_harnesses(dir)
        .into_iter()
        .map(|def| (def.id, def.command))
        .collect();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut composers = Vec::new();
    for path in entries.flatten().map(|entry| entry.path()) {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(mut value) = read_json(&path) else {
            continue;
        };
        let Some(id) = value["id"].as_str().map(str::to_string) else {
            continue;
        };
        let Some(command) = accepted.get(&id) else {
            continue;
        };
        if value.get("composer").is_none() || !seen.insert(id.clone()) {
            continue;
        }
        let refresh_args = serde_json::from_value::<ComposerSpec>(value["composer"].clone())
            .ok()
            .filter(|spec| validate(spec).is_ok())
            .map(|spec| spec.refresh)
            .unwrap_or_default();
        if !refresh_args.is_empty() {
            refresh(command, &refresh_args, &path);
            match read_json(&path) {
                Some(fresh) if fresh["id"].as_str() == Some(id.as_str()) => value = fresh,
                _ => continue,
            }
        }
        let Some(raw) = value.get("composer") else {
            continue;
        };
        match serde_json::from_value::<ComposerSpec>(raw.clone())
            .map_err(|e| e.to_string())
            .and_then(|spec| validate(&spec).map(|()| spec))
        {
            Ok(composer) => composers.push(HarnessComposer {
                harness_id: id.clone(),
                command: command.clone(),
                composer,
            }),
            Err(reason) => tracing::warn!(
                "custom_harnesses: ignoring composer in {} — {reason}",
                path.display()
            ),
        }
    }
    composers.sort_by(|a, b| a.harness_id.cmp(&b.harness_id));
    composers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: serde_json::Value) {
        std::fs::write(dir.join(name), body.to_string()).unwrap();
    }

    fn mage_composer() -> serde_json::Value {
        serde_json::json!({
            "modes": [
                { "id": "generate", "label": "Generate" },
                { "id": "edit", "label": "Edit", "requiresImage": true, "autoOnImage": true }
            ],
            "controls": [
                { "id": "model", "kind": "list", "label": "Model", "default": "mango-v4",
                  "sidecarKey": "model_id",
                  "options": [{ "value": "mango-v4", "label": "Mango 4" }, "mango-v2"] },
                { "id": "res", "kind": "segmented", "label": "Resolution", "default": "1K",
                  "defaultByMode": { "edit": "auto" },
                  "options": [{ "value": "auto", "label": "Auto", "modes": ["edit"] },
                              { "value": "1K", "scale": 1 }, { "value": "2K", "scale": 2 }] },
                { "id": "preset", "kind": "preset", "label": "Preset",
                  "options": [{ "value": "logo", "sets": { "model": "mango-v4", "res": "1K" } }] },
                { "id": "repo", "kind": "repoFolder", "label": "Save to repo",
                  "defaultFolder": "assets/" },
                { "id": "later", "kind": "slider", "label": "From a newer file" }
            ]
        })
    }

    #[test]
    fn loads_composer_for_accepted_harnesses_only() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "mage.json",
            serde_json::json!({
                "id": "mage", "label": "Mage", "command": "mage-agent", "composer": mage_composer()
            }),
        );
        write(
            dir.path(),
            "plain.json",
            serde_json::json!({
                "id": "plain", "label": "Plain", "command": "plain-acp"
            }),
        );
        write(
            dir.path(),
            "goose.json",
            serde_json::json!({
                "id": "goose", "label": "Shadow", "command": "x", "composer": mage_composer()
            }),
        );

        let loaded = load_harness_composers(dir.path());
        assert_eq!(loaded.len(), 1);
        let mage = &loaded[0];
        assert_eq!(
            (mage.harness_id.as_str(), mage.command.as_str()),
            ("mage", "mage-agent")
        );
        let model = &mage.composer.controls[0];
        assert_eq!(model.options[1].label, "mango-v2");
        assert_eq!(model.sidecar_key.as_deref(), Some("model_id"));
        let res = &mage.composer.controls[1];
        assert_eq!(res.options[2].scale, Some(2));
        assert_eq!(res.options[0].modes, ["edit"]);
        assert_eq!(mage.composer.controls[4].kind, "slider");
    }

    #[test]
    fn refresh_runs_before_the_panel_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let mut composer = mage_composer();
        composer["refresh"] = serde_json::json!(["--refresh-presets"]);
        write(
            dir.path(),
            "mage.json",
            serde_json::json!({
                "id": "mage", "label": "Mage", "command": "mage-agent", "composer": composer
            }),
        );
        let calls = std::cell::RefCell::new(Vec::new());
        let loaded = load_harness_composers_with(dir.path(), |command, args, file| {
            calls
                .borrow_mut()
                .push((command.to_string(), args.to_vec()));
            let mut harness: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
            harness["composer"]["controls"][2]["options"][0]["value"] = "fresh".into();
            std::fs::write(file, harness.to_string()).unwrap();
        });
        assert_eq!(
            calls.borrow().as_slice(),
            [(
                "mage-agent".to_string(),
                vec!["--refresh-presets".to_string()]
            )]
        );
        assert_eq!(loaded[0].composer.controls[2].options[0].value, "fresh");

        let plain = tempfile::tempdir().unwrap();
        write(
            plain.path(),
            "mage.json",
            serde_json::json!({
                "id": "mage", "label": "Mage", "command": "mage-agent", "composer": mage_composer()
            }),
        );
        let loaded = load_harness_composers_with(plain.path(), |_, _, _| {
            panic!("no refresh args, so nothing runs")
        });
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn invalid_composer_is_ignored_but_the_harness_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let mut composer = mage_composer();
        composer["controls"][2]["options"][0]["sets"]["nope"] = "x".into();
        write(
            dir.path(),
            "mage.json",
            serde_json::json!({
                "id": "mage", "label": "Mage", "command": "mage-agent", "composer": composer
            }),
        );
        assert!(load_harness_composers(dir.path()).is_empty());
        assert_eq!(load_custom_harnesses(dir.path()).len(), 1);
    }

    #[test]
    fn validation_rules() {
        let spec =
            |value: serde_json::Value| serde_json::from_value::<ComposerSpec>(value).unwrap();
        assert!(validate(&spec(mage_composer())).is_ok());

        let mut bad_value = mage_composer();
        bad_value["controls"][0]["options"][0]["value"] = "mango v4".into();
        assert!(validate(&spec(bad_value)).is_err());

        let mut unknown_mode = mage_composer();
        unknown_mode["controls"][1]["defaultByMode"] = serde_json::json!({ "fix": "auto" });
        assert!(validate(&spec(unknown_mode)).is_err());

        let mut bad_sidecar_key = mage_composer();
        bad_sidecar_key["controls"][0]["sidecarKey"] = "Model ID".into();
        assert!(validate(&spec(bad_sidecar_key)).is_err());

        let mut many_args = mage_composer();
        many_args["refresh"] = serde_json::json!(["a", "b", "c", "d", "e"]);
        assert!(validate(&spec(many_args)).is_err());

        let mut duplicate = mage_composer();
        duplicate["controls"][1]["id"] = "model".into();
        assert!(validate(&spec(duplicate)).is_err());

        let many: Vec<_> = (0..9)
            .map(|i| serde_json::json!({ "id": format!("c{i}"), "kind": "list", "label": "x" }))
            .collect();
        assert!(validate(&spec(serde_json::json!({ "controls": many }))).is_err());
    }
}
