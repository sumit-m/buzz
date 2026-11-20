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
  /** Offered only while each named earlier control has one of these values. */
  when?: Record<string, string[]>;
  /** The size shown for the first variant whose `when` matches. */
  sizes?: { when?: Record<string, string[]>; size: [number, number] }[];
  /** While picked, what other controls fall back to when their pick isn't offered. */
  defaults?: Record<string, string>;
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

/** A `when` holds while each control it names (and knows) has a listed value. */
function matches(
  when: Record<string, string[]> | undefined,
  values: Record<string, string>,
): boolean {
  return Object.entries(when ?? {}).every(
    ([id, allowed]) => values[id] === undefined || allowed.includes(values[id]),
  );
}

/** A control's options in `mode`, given the values of the controls before it. */
export function optionsFor(
  control: ComposerControl,
  mode: string,
  values: Record<string, string> = {},
): ComposerOption[] {
  return control.options.filter(
    (option) =>
      (!option.modes?.length || option.modes.includes(mode)) &&
      matches(option.when, values),
  );
}

/**
 * The mode's default, then the control's default, then what an earlier pick
 * asks for (a model's own aspect and resolution, when the control's default
 * isn't one it has), then the first option.
 */
function defaultFor(
  control: ComposerControl,
  mode: string,
  offered: ComposerOption[],
  chosen: ComposerOption[],
): string {
  const candidates = [
    control.defaultByMode?.[mode],
    control.default,
    ...chosenDefaults(control, chosen),
  ];
  return firstOffered(candidates, offered) ?? offered[0]?.value ?? "";
}

function chosenDefaults(
  control: ComposerControl,
  chosen: ComposerOption[],
): (string | undefined)[] {
  return chosen.map((option) => option.defaults?.[control.id]);
}

function firstOffered(
  candidates: (string | undefined)[],
  offered: ComposerOption[],
): string | undefined {
  return candidates.find(
    (candidate) =>
      candidate && offered.some((option) => option.value === candidate),
  );
}

export type ResolvedPanel = {
  values: Record<string, string>;
  options: Record<string, ComposerOption | null>;
};

/**
 * Every value control's value, in order: its pick while still offered,
 * otherwise its default for the mode and the earlier values.
 */
function resolve(
  spec: ComposerSpec,
  mode: string,
  pickFor: (
    control: ComposerControl,
    offered: ComposerOption[],
    chosen: ComposerOption[],
  ) => ComposerOption | undefined,
): ResolvedPanel {
  const values: Record<string, string> = {};
  const options: Record<string, ComposerOption | null> = {};
  const chosen: ComposerOption[] = [];
  for (const control of valueControls(spec)) {
    const offered = optionsFor(control, mode, values);
    const value =
      pickFor(control, offered, chosen)?.value ??
      defaultFor(control, mode, offered, chosen);
    const option = offered.find((candidate) => candidate.value === value);
    values[control.id] = value;
    options[control.id] = option ?? null;
    if (option) chosen.push(option);
  }
  return { values, options };
}

export function resolvePanel(
  state: ComposerPanelState,
  spec: ComposerSpec,
): ResolvedPanel {
  return resolve(spec, state.mode, (control, offered) =>
    offered.find((option) => option.value === state.picks[control.id]),
  );
}

/** The value a control shows and sends. */
export function effectiveValue(
  state: ComposerPanelState,
  control: ComposerControl,
  spec: ComposerSpec,
): string {
  return resolvePanel(state, spec).values[control.id] ?? "";
}

/**
 * A pick a change left unoffered (4K after switching to a model without it)
 * becomes the new pick's default for it (the model's own resolution), or is
 * dropped, so switching back doesn't revive it. Picks the mode alone hides
 * (Edit's Auto) are dropped too.
 */
function withoutStalePicks(
  state: ComposerPanelState,
  spec: ComposerSpec,
): ComposerPanelState {
  const picks: Record<string, string> = {};
  resolve(spec, state.mode, (control, offered, chosen) => {
    const pick = state.picks[control.id];
    if (!pick) return undefined;
    const kept = offered.find((option) => option.value === pick);
    const inMode = optionsFor(control, state.mode).some(
      (option) => option.value === pick,
    );
    const value =
      kept?.value ??
      (inMode
        ? firstOffered(chosenDefaults(control, chosen), offered)
        : undefined);
    if (value) picks[control.id] = value;
    return offered.find((option) => option.value === value);
  });
  return { ...state, picks };
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
  return stateFromSidecar(spec, values, repo, "edit");
}

/**
 * The panel as an image's sidecar describes it, in its image mode (`edit`) or
 * its first mode without one (`generate`): what Regenerate sends again.
 */
export function stateFromSidecar(
  spec: ComposerSpec,
  values: Record<string, string>,
  repo: string | null,
  kind: "generate" | "edit",
): ComposerPanelState {
  const mode =
    spec.modes.find((candidate) =>
      kind === "edit" ? candidate.requiresImage : !candidate.requiresImage,
    )?.id ?? defaultMode(spec);
  const picks: Record<string, string> = {};
  resolve(spec, mode, (control, offered) => {
    const value = control.sidecarKey ? values[control.sidecarKey] : undefined;
    const option = value
      ? offered.find(
          (candidate) => candidate.value.toLowerCase() === value.toLowerCase(),
        )
      : undefined;
    if (option) picks[control.id] = option.value;
    return option;
  });
  return {
    mode,
    picks,
    preset: null,
    repo: repoControl(spec) ? repo : null,
  };
}

export function pickValue(
  state: ComposerPanelState,
  spec: ComposerSpec,
  controlId: string,
  value: string,
): ComposerPanelState {
  return withoutStalePicks(
    { ...state, picks: { ...state.picks, [controlId]: value } },
    spec,
  );
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
  return withoutStalePicks(
    {
      ...state,
      preset: presetValue,
      picks: { ...state.picks, ...(option.sets ?? {}) },
    },
    spec,
  );
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
  const controls: Record<string, string> = {
    ...resolvePanel(state, spec).values,
  };
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

/**
 * `[w, h]` of a `shapes` option: its size variant for the current values,
 * else its size at the resolution control's current scale.
 */
export function scaledSize(
  option: ComposerOption,
  resolved: ResolvedPanel,
  spec: ComposerSpec,
): [number, number] | null {
  const variant = option.sizes?.find((candidate) =>
    matches(candidate.when, resolved.values),
  );
  if (variant) return variant.size;
  if (!option.size) return null;
  let scale = 1;
  for (const control of valueControls(spec)) {
    if (control.kind !== "segmented") continue;
    const current = resolved.options[control.id];
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
