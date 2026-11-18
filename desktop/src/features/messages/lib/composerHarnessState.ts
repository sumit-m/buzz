/**
 * LOCAL DIVERGENCE: state rules for the message-box panel a custom harness
 * declares (`composer` in its harness file). Pure — no React, no Tauri.
 *
 * The panel never shows CLI flags: it sends values by control id in a hidden
 * `buzz-composer` tag, and the harness maps them to its own CLI.
 */

export type ComposerOption = {
  value: string;
  label: string;
  size?: [number, number];
  scale?: number;
  sets?: Record<string, string>;
  modes?: string[];
  /** `https` thumbnail of an `assets` option. */
  image?: string;
  hint?: string;
};

export type ComposerControl = {
  id: string;
  kind: string;
  label: string;
  icon?: string;
  default?: string;
  defaultByMode?: Record<string, string>;
  options: ComposerOption[];
  defaultFolder?: string;
  /** The image sidecar key holding this control's value. */
  sidecarKey?: string;
  /** Heading of the control's menu. */
  title?: string;
  /** Set when opening the menu re-reads its options from the harness. */
  refresh?: string[];
};

export type ComposerMode = {
  id: string;
  label: string;
  requiresImage?: boolean;
  autoOnImage?: boolean;
};

export type ComposerSpec = {
  modes: ComposerMode[];
  controls: ComposerControl[];
};

export type HarnessComposer = {
  harnessId: string;
  command: string;
  composer: ComposerSpec;
};

/** `list`, `shapes` and `segmented` controls: one value from a fixed set. */
const VALUE_KINDS = new Set(["list", "shapes", "segmented"]);

export const COMPOSER_TAG = "buzz-composer";

export type ComposerPanelState = {
  mode: string;
  /** Explicit picks only; untouched controls follow the mode's default. */
  picks: Record<string, string>;
  preset: string | null;
  repo: string | null;
};

export type SavedComposerState = {
  picks?: Record<string, string>;
  preset?: string | null;
  repo?: string | null;
  prompt?: string;
};

export function valueControls(spec: ComposerSpec): ComposerControl[] {
  return spec.controls.filter((control) => VALUE_KINDS.has(control.kind));
}

export function presetControl(spec: ComposerSpec): ComposerControl | null {
  return spec.controls.find((control) => control.kind === "preset") ?? null;
}

export function repoControl(spec: ComposerSpec): ComposerControl | null {
  return spec.controls.find((control) => control.kind === "repoFolder") ?? null;
}

export function optionsFor(
  control: ComposerControl,
  mode: string,
): ComposerOption[] {
  return control.options.filter(
    (option) => !option.modes?.length || option.modes.includes(mode),
  );
}

function defaultFor(control: ComposerControl, mode: string): string {
  const options = optionsFor(control, mode);
  const declared = control.defaultByMode?.[mode] ?? control.default;
  if (declared && options.some((option) => option.value === declared)) {
    return declared;
  }
  return options[0]?.value ?? "";
}

/** The value a control shows and sends in the current mode. */
export function effectiveValue(
  state: ComposerPanelState,
  control: ComposerControl,
): string {
  const pick = state.picks[control.id];
  if (pick && optionsFor(control, state.mode).some((o) => o.value === pick)) {
    return pick;
  }
  return defaultFor(control, state.mode);
}

export function effectiveOption(
  state: ComposerPanelState,
  control: ComposerControl,
): ComposerOption | null {
  const value = effectiveValue(state, control);
  return control.options.find((option) => option.value === value) ?? null;
}

export function defaultMode(spec: ComposerSpec): string {
  return spec.modes[0]?.id ?? "";
}

/**
 * Restores the channel's last request. Values that are no longer options are
 * dropped; the mode always starts at the default (it follows attachments).
 */
export function initialPanelState(
  spec: ComposerSpec,
  saved?: SavedComposerState | null,
): ComposerPanelState {
  const picks: Record<string, string> = {};
  for (const control of valueControls(spec)) {
    const value = saved?.picks?.[control.id];
    if (value && control.options.some((option) => option.value === value)) {
      picks[control.id] = value;
    }
  }
  const preset = saved?.preset ?? null;
  const presetValid =
    preset !== null &&
    (presetControl(spec)?.options.some((option) => option.value === preset) ??
      false);
  return {
    mode: defaultMode(spec),
    picks,
    preset: presetValid ? preset : null,
    repo: repoControl(spec) ? (saved?.repo ?? null) : null,
  };
}

/**
 * "Edit" on a generated image: the image mode with each control set from the
 * image's sidecar where it names an option of that mode, saving to `repo`.
 * No preset, since the values already came from one.
 */
export function editStateFromSidecar(
  spec: ComposerSpec,
  values: Record<string, string>,
  repo: string | null,
): ComposerPanelState {
  const mode =
    spec.modes.find((candidate) => candidate.requiresImage)?.id ??
    defaultMode(spec);
  const picks: Record<string, string> = {};
  for (const control of valueControls(spec)) {
    const value = control.sidecarKey ? values[control.sidecarKey] : undefined;
    const option = value
      ? optionsFor(control, mode).find(
          (candidate) => candidate.value.toLowerCase() === value.toLowerCase(),
        )
      : undefined;
    if (option) picks[control.id] = option.value;
  }
  return {
    mode,
    picks,
    preset: null,
    repo: repoControl(spec) ? repo : null,
  };
}

export function pickValue(
  state: ComposerPanelState,
  controlId: string,
  value: string,
): ComposerPanelState {
  return { ...state, picks: { ...state.picks, [controlId]: value } };
}

/** A preset sets every control it names; "None" (null) leaves them as is. */
export function applyPreset(
  state: ComposerPanelState,
  spec: ComposerSpec,
  presetValue: string | null,
): ComposerPanelState {
  if (presetValue === null) return { ...state, preset: null };
  const option = presetControl(spec)?.options.find(
    (candidate) => candidate.value === presetValue,
  );
  if (!option) return state;
  return {
    ...state,
    preset: presetValue,
    picks: { ...state.picks, ...(option.sets ?? {}) },
  };
}

export function setMode(
  state: ComposerPanelState,
  mode: string,
): ComposerPanelState {
  return { ...state, mode };
}

export function setRepo(
  state: ComposerPanelState,
  repo: string | null,
): ComposerPanelState {
  return { ...state, repo };
}

/**
 * Attaching the first image switches to the image mode; removing the last
 * one switches back to the default mode.
 */
export function followAttachments(
  state: ComposerPanelState,
  spec: ComposerSpec,
  previousImages: number,
  images: number,
): ComposerPanelState {
  if (previousImages === 0 && images > 0) {
    const imageMode = spec.modes.find((mode) => mode.autoOnImage);
    return imageMode ? setMode(state, imageMode.id) : state;
  }
  if (previousImages > 0 && images === 0) {
    return setMode(state, defaultMode(spec));
  }
  return state;
}

/** Why sending is blocked, or null. */
export function sendBlockReason(
  state: ComposerPanelState,
  spec: ComposerSpec,
  images: number,
): string | null {
  const mode = spec.modes.find((candidate) => candidate.id === state.mode);
  if (mode?.requiresImage && images === 0) {
    return `Attach an image to ${mode.label.toLowerCase()}`;
  }
  return null;
}

export type ComposerPayload = {
  v: 1;
  mode: string;
  controls: Record<string, string>;
};

/** Every value control is sent with its current value; unset repo and preset are left out. */
export function composerPayload(
  state: ComposerPanelState,
  spec: ComposerSpec,
): ComposerPayload {
  const controls: Record<string, string> = {};
  for (const control of valueControls(spec)) {
    controls[control.id] = effectiveValue(state, control);
  }
  const preset = presetControl(spec);
  if (
    preset &&
    state.preset &&
    preset.options.some((option) => option.value === state.preset)
  ) {
    controls[preset.id] = state.preset;
  }
  const repo = repoControl(spec);
  if (repo && state.repo) controls[repo.id] = state.repo;
  return { v: 1, mode: state.mode, controls };
}

export function composerTag(
  harnessId: string,
  payload: ComposerPayload,
): string[] {
  return [COMPOSER_TAG, harnessId, JSON.stringify(payload)];
}

export function toSavedState(
  state: ComposerPanelState,
  prompt: string,
): SavedComposerState {
  return {
    picks: state.picks,
    preset: state.preset,
    repo: state.repo,
    prompt,
  };
}

/** `[w, h]` of a `shapes` option at the resolution control's current scale. */
export function scaledSize(
  option: ComposerOption,
  state: ComposerPanelState,
  spec: ComposerSpec,
): [number, number] | null {
  if (!option.size) return null;
  let scale = 1;
  for (const control of valueControls(spec)) {
    if (control.kind !== "segmented") continue;
    const current = effectiveOption(state, control);
    if (current?.scale) scale = current.scale;
  }
  return [option.size[0] * scale, option.size[1] * scale];
}

/**
 * The agent an image edit goes to: the image's author when it runs on a
 * harness with an image mode, else the first such agent.
 */
export function editTargetFor<
  Agent extends {
    pubkey: string;
    runtime: string | null;
    agentCommand: string;
  },
>(
  composers: readonly HarnessComposer[],
  agents: readonly Agent[],
  authorPubkey: string | null,
): { agent: Agent; harness: HarnessComposer } | null {
  const targets = agents.flatMap((agent) => {
    const harness = harnessComposerForAgent(composers, agent);
    return harness?.composer.modes.some((mode) => mode.requiresImage)
      ? [{ agent, harness }]
      : [];
  });
  const author = authorPubkey?.toLowerCase();
  return (
    targets.find((target) => target.agent.pubkey.toLowerCase() === author) ??
    targets[0] ??
    null
  );
}

/** Matches a managed agent to its harness by harness id or resolved command. */
export function harnessComposerForAgent(
  composers: readonly HarnessComposer[],
  agent: { runtime: string | null; agentCommand: string },
): HarnessComposer | null {
  const normalize = (command: string) =>
    command.trim().replace(/\\/g, "/").toLowerCase();
  const command = normalize(agent.agentCommand);
  return (
    composers.find(
      (entry) =>
        entry.harnessId === agent.runtime ||
        (command.length > 0 && normalize(entry.command) === command),
    ) ?? null
  );
}
