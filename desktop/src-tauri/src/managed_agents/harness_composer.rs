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
/// An `assets` menu lists the user's own characters or references.
const MAX_ASSET_OPTIONS: usize = 200;
const MAX_URL: usize = 2048;
const MAX_TEXT: usize = 64;
const MAX_REFRESH_ARGS: usize = 4;
/// Size variants of one option (models × resolutions).
const MAX_SIZES: usize = 32;
const REFRESH_TIMEOUT: Duration = Duration::from_secs(5);
/// A menu refresh may ask a service (mage lists assets over the network).
const CONTROL_REFRESH_TIMEOUT: Duration = Duration::from_secs(20);

/// Refreshes rewrite the same harness file, so they run one at a time.
static REFRESH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
    /// `list`, `shapes`, `segmented`, `preset`, `assets` or `repoFolder`.
    /// Other kinds are kept and ignored by the renderer, so a newer file
    /// still loads.
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub default_by_mode: BTreeMap<String, String>,
    /// The default while images are attached (an image's own Auto size).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_with_images: Option<String>,
    /// Shown only while each named control has one of these values.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub when: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub options: Vec<ComposerOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_folder: Option<String>,
    /// The key in an image's `.json` sidecar that holds this control's value,
    /// so "Edit" on an image can start from the settings that made it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidecar_key: Option<String>,
    /// Heading of the control's menu, when it differs from the label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Arguments for the harness command that rewrites this control's options
    /// when its menu opens (`refresh_harness_control`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refresh: Vec<String>,
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
    /// An `https` thumbnail, for `assets` options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Secondary text shown beside the label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Offered only while each named earlier control has one of these values
    /// (Resolution's 4K only for the models that have it).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub when: BTreeMap<String, Vec<String>>,
    /// The size shown for the first variant whose `when` matches, ahead of
    /// `size` × the resolution's `scale`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sizes: Vec<SizeVariant>,
    /// While this option is picked, the value each named control falls back to
    /// when its own pick isn't offered (a model's default aspect and resolution).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub defaults: BTreeMap<String, String>,
    /// While picked, sending is blocked above this many attached images.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_images: Option<u32>,
    /// While picked, attached images can be inserted into the prompt.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub image_refs: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SizeVariant {
    #[serde(default)]
    pub when: BTreeMap<String, Vec<String>>,
    pub size: [u32; 2],
}

/// An option may be written as a bare string (`"1K"`) or as an object.
#[derive(Deserialize)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant)] // lives only while deserializing
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
        #[serde(default)]
        image: Option<String>,
        #[serde(default)]
        hint: Option<String>,
        #[serde(default)]
        when: BTreeMap<String, Vec<String>>,
        #[serde(default)]
        sizes: Vec<SizeVariant>,
        #[serde(default)]
        defaults: BTreeMap<String, String>,
        #[serde(default, rename = "maxImages")]
        max_images: Option<u32>,
        #[serde(default, rename = "imageRefs")]
        image_refs: bool,
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
                image: None,
                hint: None,
                when: BTreeMap::new(),
                sizes: Vec::new(),
                defaults: BTreeMap::new(),
                max_images: None,
                image_refs: false,
            },
            RawOption::Full {
                value,
                label,
                size,
                scale,
                sets,
                modes,
                image,
                hint,
                when,
                sizes,
                defaults,
                max_images,
                image_refs,
            } => ComposerOption {
                label: label.unwrap_or_else(|| value.clone()),
                value,
                size,
                scale,
                sets,
                modes,
                image,
                hint,
                when,
                sizes,
                defaults,
                max_images,
                image_refs,
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

/// The `when` key that follows the attachments rather than a control.
const IMAGES_KEY: &str = "@images";
const IMAGES_VALUES: [&str; 2] = ["none", "attached"];
/// The most images one request may declare (`maxImages`).
const MAX_IMAGES: u32 = 50;

/// `when` names value controls by id, with 1-[`MAX_OPTIONS`] valid values each,
/// or `@images` with `none` / `attached`.
fn check_when(
    control: &str,
    when: &BTreeMap<String, Vec<String>>,
    allowed: &HashSet<&str>,
) -> Result<(), String> {
    for (id, values) in when {
        if id == IMAGES_KEY {
            if values.is_empty() || values.iter().any(|v| !IMAGES_VALUES.contains(&v.as_str())) {
                return Err(format!(
                    "{control}: when {IMAGES_KEY:?} takes \"none\" and/or \"attached\""
                ));
            }
            continue;
        }
        if !allowed.contains(id.as_str()) {
            return Err(format!(
                "{control}: when names {id:?}, which it can't follow"
            ));
        }
        if values.is_empty()
            || values.len() > MAX_OPTIONS
            || values.iter().any(|value| !is_value(value))
        {
            return Err(format!(
                "{control}: when {id:?} needs 1-{MAX_OPTIONS} valid values"
            ));
        }
    }
    Ok(())
}

fn is_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TEXT
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\'')
}

fn check_refresh(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_REFRESH_ARGS
        || args
            .iter()
            .any(|arg| arg.is_empty() || arg.len() > MAX_TEXT || arg.chars().any(char::is_control))
    {
        return Err(format!(
            "refresh takes at most {MAX_REFRESH_ARGS} arguments of 1-{MAX_TEXT} characters"
        ));
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
    check_refresh(&spec.refresh)?;
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
    let value_ids: HashSet<&str> = spec
        .controls
        .iter()
        .filter(|c| matches!(c.kind.as_str(), "list" | "shapes" | "segmented"))
        .map(|c| c.id.as_str())
        .collect();
    // An option's `when` follows earlier controls only, so values resolve in
    // order; a size is shown once every value is known, so it may follow any.
    let mut earlier: HashSet<&str> = HashSet::new();
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
        if let Some(title) = &control.title {
            check_text("control title", title)?;
        }
        check_refresh(&control.refresh).map_err(|e| format!("{}: {e}", control.id))?;
        let max_options = if control.kind == "assets" {
            MAX_ASSET_OPTIONS
        } else {
            MAX_OPTIONS
        };
        if control.options.len() > max_options {
            return Err(format!("{}: at most {max_options} options", control.id));
        }
        for mode in control.default_by_mode.keys() {
            if !mode_ids.contains(mode.as_str()) {
                return Err(format!(
                    "{}: defaultByMode names unknown mode {mode:?}",
                    control.id
                ));
            }
        }
        if let Some(value) = &control.default_with_images {
            if !is_value(value) {
                return Err(format!(
                    "{}: defaultWithImages {value:?} is invalid",
                    control.id
                ));
            }
        }
        // A control is shown once every value is known, so it may follow any.
        check_when(&control.id, &control.when, &value_ids)?;
        for option in &control.options {
            check_text("option label", &option.label)?;
            if !is_value(&option.value) {
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
            if let Some(hint) = &option.hint {
                check_text("option hint", hint)?;
            }
            if option
                .image
                .as_ref()
                .is_some_and(|url| url.len() > MAX_URL || !url.starts_with("https://"))
            {
                return Err(format!("{}: option image must be an https URL", control.id));
            }
            if let Some(mode) = option.modes.iter().find(|m| !mode_ids.contains(m.as_str())) {
                return Err(format!(
                    "{}: option names unknown mode {mode:?}",
                    control.id
                ));
            }
            check_when(&control.id, &option.when, &earlier)?;
            if option.max_images.is_some_and(|n| n == 0 || n > MAX_IMAGES) {
                return Err(format!(
                    "{}: maxImages must be 1-{MAX_IMAGES}",
                    control.id
                ));
            }
            if option.sizes.len() > MAX_SIZES {
                return Err(format!("{}: at most {MAX_SIZES} sizes", control.id));
            }
            for variant in &option.sizes {
                check_when(&control.id, &variant.when, &value_ids)?;
            }
            if let Some((id, value)) = option
                .defaults
                .iter()
                .find(|(id, value)| !value_ids.contains(id.as_str()) || !is_value(value))
            {
                return Err(format!(
                    "{}: default {value:?} for {id:?} is invalid",
                    control.id
                ));
            }
        }
        if value_ids.contains(control.id.as_str()) {
            earlier.insert(control.id.as_str());
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
    run_bounded_refresh(command, args, harness_file, REFRESH_TIMEOUT);
}

fn run_bounded_refresh(command: &str, args: &[String], harness_file: &Path, timeout: Duration) {
    let _one_at_a_time = REFRESH_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut cmd = std::process::Command::new(command);
    cmd.args(args).env("BUZZ_HARNESS_FILE", harness_file);
    match super::discovery::bounded_command::output_with_timeout(cmd, timeout) {
        Some(output) if output.status.success() => {}
        Some(output) => tracing::warn!(
            "custom_harnesses: {command} refresh exited with {}",
            output.status
        ),
        None => tracing::warn!("custom_harnesses: {command} refresh failed or timed out"),
    }
}

/// Runs the refresh that `control_id` of `harness_id` declares (its menu just
/// opened), then reads the panels again.
pub(crate) fn refresh_harness_control(
    dir: &Path,
    harness_id: &str,
    control_id: &str,
) -> Vec<HarnessComposer> {
    refresh_harness_control_with(dir, harness_id, control_id, |command, args, file| {
        run_bounded_refresh(command, args, file, CONTROL_REFRESH_TIMEOUT)
    })
}

fn refresh_harness_control_with(
    dir: &Path,
    harness_id: &str,
    control_id: &str,
    refresh: impl Fn(&str, &[String], &Path),
) -> Vec<HarnessComposer> {
    if let Some((command, path, args)) = control_refresh(dir, harness_id, control_id) {
        refresh(&command, &args, &path);
    }
    load_harness_composers(dir)
}

/// The command, harness file and refresh arguments of an accepted harness's
/// control, when it declares a refresh.
fn control_refresh(
    dir: &Path,
    harness_id: &str,
    control_id: &str,
) -> Option<(String, std::path::PathBuf, Vec<String>)> {
    let command = load_custom_harnesses(dir)
        .into_iter()
        .find(|def| def.id == harness_id)?
        .command;
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .find_map(|path| {
            let value = read_json(&path)?;
            if value["id"].as_str() != Some(harness_id) {
                return None;
            }
            let spec = serde_json::from_value::<ComposerSpec>(value["composer"].clone())
                .ok()
                .filter(|spec| validate(spec).is_ok())?;
            let args = spec
                .controls
                .into_iter()
                .find(|control| control.id == control_id)?
                .refresh;
            (!args.is_empty()).then_some((path, args))
        })
        .map(|(path, args)| (command, path, args))
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

    fn with_assets_menu() -> serde_json::Value {
        let mut composer = mage_composer();
        composer["controls"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "character", "kind": "assets", "label": "Character",
                "title": "Choose Your Character", "refresh": ["--refresh-assets"],
                "options": [{ "value": "ryantennis", "label": "ryan tennis",
                              "image": "https://cdn.example/c.jpg", "hint": "Outfit" }]
            }));
        composer
    }

    #[test]
    fn control_refresh_runs_its_own_args_then_rereads() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "mage.json",
            serde_json::json!({
                "id": "mage", "label": "Mage", "command": "mage-agent", "composer": with_assets_menu()
            }),
        );
        let calls = std::cell::RefCell::new(Vec::new());
        let loaded = refresh_harness_control_with(dir.path(), "mage", "character", |c, a, file| {
            calls.borrow_mut().push((c.to_string(), a.to_vec()));
            let mut harness: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
            harness["composer"]["controls"][5]["options"][0]["value"] = "fresh".into();
            std::fs::write(file, harness.to_string()).unwrap();
        });
        assert_eq!(
            calls.borrow().as_slice(),
            [(
                "mage-agent".to_string(),
                vec!["--refresh-assets".to_string()]
            )]
        );
        let menu = &loaded[0].composer.controls[5];
        assert_eq!(menu.options[0].value, "fresh");
        assert_eq!(menu.title.as_deref(), Some("Choose Your Character"));
        assert_eq!(menu.options[0].hint.as_deref(), Some("Outfit"));

        for (harness, control) in [("mage", "model"), ("mage", "nope"), ("goose", "character")] {
            let loaded = refresh_harness_control_with(dir.path(), harness, control, |_, _, _| {
                panic!("{harness}/{control} declares no refresh")
            });
            assert_eq!(loaded.len(), 1);
        }
    }

    #[test]
    fn asset_menu_validation() {
        let spec =
            |value: serde_json::Value| serde_json::from_value::<ComposerSpec>(value).unwrap();
        assert!(validate(&spec(with_assets_menu())).is_ok());

        let mut plain_http = with_assets_menu();
        plain_http["controls"][5]["options"][0]["image"] = "http://cdn.example/c.jpg".into();
        assert!(validate(&spec(plain_http)).is_err());

        let mut long_hint = with_assets_menu();
        long_hint["controls"][5]["options"][0]["hint"] = "x".repeat(65).into();
        assert!(validate(&spec(long_hint)).is_err());

        let mut bad_refresh = with_assets_menu();
        bad_refresh["controls"][5]["refresh"] = serde_json::json!([""]);
        assert!(validate(&spec(bad_refresh)).is_err());

        let many = |n: usize| -> serde_json::Value {
            (0..n)
                .map(|i| serde_json::json!({ "value": format!("h{i}"), "label": "x" }))
                .collect()
        };
        let mut big_menu = with_assets_menu();
        big_menu["controls"][5]["options"] = many(200);
        assert!(validate(&spec(big_menu.clone())).is_ok());
        big_menu["controls"][5]["options"] = many(201);
        assert!(validate(&spec(big_menu)).is_err());
        let mut big_list = mage_composer();
        big_list["controls"][0]["options"] = many(51);
        assert!(validate(&spec(big_list)).is_err());
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

    #[test]
    fn options_may_follow_earlier_controls() {
        let spec =
            |value: serde_json::Value| serde_json::from_value::<ComposerSpec>(value).unwrap();
        let mut composer = mage_composer();
        composer["controls"][0]["options"][0]["defaults"] = serde_json::json!({ "res": "2K" });
        composer["controls"][1]["options"][2]["when"] =
            serde_json::json!({ "model": ["mango-v4"] });
        composer["controls"][1]["options"][1]["sizes"] = serde_json::json!([
            { "when": { "model": ["mango-v2"], "res": ["1K"] }, "size": [896, 1152] }
        ]);
        let parsed = spec(composer.clone());
        assert!(validate(&parsed).is_ok());
        assert_eq!(parsed.controls[1].options[1].sizes[0].size, [896, 1152]);

        let mut later = composer.clone();
        later["controls"][0]["options"][0]["when"] = serde_json::json!({ "res": ["1K"] });
        assert!(validate(&spec(later)).is_err());

        let mut not_a_value = composer.clone();
        not_a_value["controls"][1]["options"][2]["when"] =
            serde_json::json!({ "preset": ["logo"] });
        assert!(validate(&spec(not_a_value)).is_err());

        let mut empty = composer.clone();
        empty["controls"][1]["options"][2]["when"] = serde_json::json!({ "model": [] });
        assert!(validate(&spec(empty)).is_err());

        let mut bad_default = composer;
        bad_default["controls"][0]["options"][0]["defaults"] = serde_json::json!({ "repo": "x" });
        assert!(validate(&spec(bad_default)).is_err());
    }

    #[test]
    fn image_rules_follow_attachments_and_the_model() {
        let spec =
            |value: serde_json::Value| serde_json::from_value::<ComposerSpec>(value).unwrap();
        let mut composer = mage_composer();
        composer["controls"][0]["options"][0]["maxImages"] = serde_json::json!(10);
        composer["controls"][0]["options"][0]["imageRefs"] = serde_json::json!(true);
        composer["controls"][1]["defaultWithImages"] = serde_json::json!("auto");
        composer["controls"][1]["options"][0]["when"] =
            serde_json::json!({ "@images": ["attached"] });
        composer["controls"][2]["when"] = serde_json::json!({ "model": ["mango-v4"] });
        let parsed = spec(composer.clone());
        assert!(validate(&parsed).is_ok());
        assert_eq!(parsed.controls[0].options[0].max_images, Some(10));
        assert!(parsed.controls[0].options[0].image_refs);
        assert!(!parsed.controls[0].options[1].image_refs);
        assert_eq!(parsed.controls[1].default_with_images.as_deref(), Some("auto"));
        let written = serde_json::to_value(&parsed).unwrap();
        assert_eq!(written["controls"][0]["options"][0]["maxImages"], 10);
        assert_eq!(written["controls"][0]["options"][0]["imageRefs"], true);
        assert!(written["controls"][0]["options"][1].get("imageRefs").is_none());

        let mut bad_images = composer.clone();
        bad_images["controls"][1]["options"][0]["when"] =
            serde_json::json!({ "@images": ["some"] });
        assert!(validate(&spec(bad_images)).is_err());

        let mut zero = composer.clone();
        zero["controls"][0]["options"][0]["maxImages"] = serde_json::json!(0);
        assert!(validate(&spec(zero)).is_err());

        let mut unknown = composer;
        unknown["controls"][2]["when"] = serde_json::json!({ "repo": ["x"] });
        assert!(validate(&spec(unknown)).is_err());
    }
}
