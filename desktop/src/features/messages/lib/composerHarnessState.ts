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
  /** While picked, sending is blocked above this many attached images. */
  maxImages?: number;
  /** While picked, attached images can be inserted into the prompt. */
  imageRefs?: boolean;
};

export type ComposerControl = {
  id: string;
  kind: string;
  label: string;
  icon?: string;
  default?: string;
  defaultByMode?: Record<string, string>;
  /** The default while images are attached (an image's own Auto size). */
  defaultWithImages?: string;
  /** Shown only while it matches (a menu only some models support). */
  when?: Record<string, string[]>;
  /** Shown, and sent, only in these modes (all when unset). */
  modes?: string[];
  /** A `number` control's range and the text after its value. */
  min?: number;
  max?: number;
  unit?: string;
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

/**
 * Controls with one value: `list`, `shapes` and `segmented` from a fixed set,
 * `number` from its range, `imagePick` from the attached images.
 */
const VALUE_KINDS = new Set([
  "list",
  "shapes",
  "segmented",
  "number",
  "imagePick",
]);

export const COMPOSER_TAG = "buzz-composer";

/**
 * The `when` key that follows the attached images: `none`, `one` or
 * `several`; `attached` matches either of the last two.
 */
export const IMAGES_KEY = "@images";
/** The `when` key that follows attached videos: `none` or `attached`. */
export const VIDEOS_KEY = "@videos";
/** An `imagePick` control's value with no image picked. */
export const NO_IMAGE = "none";

export type ComposerPanelState = {
  mode: string;
  /** Images attached to the draft. */
  images: number;
  /** Videos attached to the draft. */
  videos: number;
  /** Explicit picks only; untouched controls follow the mode's default. */
  picks: Record<string, string>;
  preset: string | null;
  repo: string | null;
};

export type SavedComposerState = {
  mode?: string;
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

/** The presets for `mode` (a preset naming no modes is for every mode). */
export function presetOptions(
  spec: ComposerSpec,
  mode: string,
): ComposerOption[] {
  return (presetControl(spec)?.options ?? []).filter((option) =>
    inMode(option, mode),
  );
}

/** The picked preset, while it's one for the current mode. */
export function activePreset(
  state: ComposerPanelState,
  spec: ComposerSpec,
): string | null {
  return presetOptions(spec, state.mode).some(
    (option) => option.value === state.preset,
  )
    ? state.preset
    : null;
}

export function repoControl(spec: ComposerSpec): ComposerControl | null {
  return spec.controls.find((control) => control.kind === "repoFolder") ?? null;
}

/** A `when` holds while each control it names (and knows) has a listed value. */
function matches(
  when: Record<string, string[]> | undefined,
  values: Record<string, string>,
): boolean {
  return Object.entries(when ?? {}).every(([id, allowed]) => {
    const value = values[id];
    if (value === undefined || allowed.includes(value)) return true;
    return (
      id === IMAGES_KEY && value !== "none" && allowed.includes("attached")
    );
  });
}

function inMode(item: { modes?: string[] }, mode: string): boolean {
  return !item.modes?.length || item.modes.includes(mode);
}

/** A `number` control's values, as options labelled with its unit. */
function numberOptions(control: ComposerControl): ComposerOption[] {
  const min = control.min ?? 1;
  const max = Math.max(min, control.max ?? min);
  return Array.from({ length: max - min + 1 }, (_, i) => ({
    value: String(min + i),
    label: `${min + i}${control.unit ?? ""}`,
  }));
}

/** An `imagePick` control's options: None, then each attached image. */
function imagePickOptions(images: number): ComposerOption[] {
  if (images === 0) return [];
  return [
    { value: NO_IMAGE, label: "None" },
    ...Array.from({ length: images }, (_, i) => ({
      value: String(i + 1),
      label: `Image ${i + 1}`,
    })),
  ];
}

/** A control's options in `mode`, given the values of the controls before it. */
export function optionsFor(
  control: ComposerControl,
  mode: string,
  values: Record<string, string> = {},
  images = 0,
): ComposerOption[] {
  if (control.kind === "number") return numberOptions(control);
  if (control.kind === "imagePick") return imagePickOptions(images);
  return control.options.filter(
    (option) => inMode(option, mode) && matches(option.when, values),
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
  images: number,
  offered: ComposerOption[],
  chosen: ComposerOption[],
): string {
  const candidates = [
    control.defaultByMode?.[mode],
    images > 0 ? control.defaultWithImages : undefined,
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
  mode: string;
  values: Record<string, string>;
  options: Record<string, ComposerOption | null>;
};

type Attachments = { images: number; videos: number };

function imagesValue(images: number): string {
  if (images === 0) return "none";
  return images === 1 ? "one" : "several";
}

function attachmentValues({
  images,
  videos,
}: Attachments): Record<string, string> {
  return {
    [IMAGES_KEY]: imagesValue(images),
    [VIDEOS_KEY]: videos > 0 ? "attached" : "none",
  };
}

/**
 * Every value control's value, in order: its pick while still offered,
 * otherwise its default for the mode and the earlier values. A control in
 * other modes, or with nothing to offer (a pick of no images), has none.
 * `values` also holds `@images` and `@videos`, which `when` may follow;
 * they're never sent.
 */
function resolve(
  spec: ComposerSpec,
  mode: string,
  attachments: Attachments,
  pickFor: (
    control: ComposerControl,
    offered: ComposerOption[],
    chosen: ComposerOption[],
  ) => ComposerOption | undefined,
): ResolvedPanel {
  const images = attachments.images;
  const values: Record<string, string> = attachmentValues(attachments);
  const options: Record<string, ComposerOption | null> = {};
  const chosen: ComposerOption[] = [];
  for (const control of valueControls(spec)) {
    if (!inMode(control, mode)) continue;
    const offered = optionsFor(control, mode, values, images);
    if (offered.length === 0 && control.kind === "imagePick") continue;
    const value =
      pickFor(control, offered, chosen)?.value ??
      defaultFor(control, mode, images, offered, chosen);
    const option = offered.find((candidate) => candidate.value === value);
    values[control.id] = value;
    options[control.id] = option ?? null;
    if (option) chosen.push(option);
  }
  return { mode, values, options };
}

export function resolvePanel(
  state: ComposerPanelState,
  spec: ComposerSpec,
): ResolvedPanel {
  return resolve(spec, state.mode, state, (control, offered) =>
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
 * dropped, so switching back doesn't revive it. Picks the mode or the
 * attachments alone hide (Auto with no image) are dropped too.
 */
function withoutStalePicks(
  state: ComposerPanelState,
  spec: ComposerSpec,
): ComposerPanelState {
  // Picks for controls of other modes are kept for when the mode returns.
  const picks: Record<string, string> = Object.fromEntries(
    Object.entries(state.picks).filter(([id]) => {
      const control = spec.controls.find((candidate) => candidate.id === id);
      return control !== undefined && !inMode(control, state.mode);
    }),
  );
  const attachments = attachmentValues(state);
  resolve(spec, state.mode, state, (control, offered, chosen) => {
    const pick = state.picks[control.id];
    if (!pick) return undefined;
    const kept = offered.find((option) => option.value === pick);
    const offeredInMode = optionsFor(
      control,
      state.mode,
      attachments,
      state.images,
    ).some((option) => option.value === pick);
    const value =
      kept?.value ??
      (offeredInMode
        ? firstOffered(chosenDefaults(control, chosen), offered)
        : undefined);
    if (value) picks[control.id] = value;
    return offered.find((option) => option.value === value);
  });
  return { ...state, picks };
}

/** Whether `value` is one the control can ever hold. */
function isValueOf(control: ComposerControl, value: string): boolean {
  if (control.kind === "number") {
    return numberOptions(control).some((option) => option.value === value);
  }
  if (control.kind === "imagePick") {
    return value === NO_IMAGE || /^[1-9]\d?$/.test(value);
  }
  return control.options.some((option) => option.value === value);
}

export function defaultMode(spec: ComposerSpec): string {
  return spec.modes[0]?.id ?? "";
}

/**
 * Restores the channel's last request. Values that are no longer options are
 * dropped. Its mode comes back unless that mode follows attachments (Edit),
 * which then starts at the default.
 */
export function initialPanelState(
  spec: ComposerSpec,
  saved?: SavedComposerState | null,
): ComposerPanelState {
  const picks: Record<string, string> = {};
  for (const control of valueControls(spec)) {
    const value = saved?.picks?.[control.id];
    if (value && isValueOf(control, value)) picks[control.id] = value;
  }
  const preset = saved?.preset ?? null;
  const presetValid =
    preset !== null &&
    (presetControl(spec)?.options.some((option) => option.value === preset) ??
      false);
  const savedMode = spec.modes.find((mode) => mode.id === saved?.mode);
  return {
    mode:
      savedMode && !savedMode.autoOnImage && !savedMode.requiresImage
        ? savedMode.id
        : defaultMode(spec),
    images: 0,
    videos: 0,
    picks,
    preset: presetValid ? preset : null,
    repo: repoControl(spec) ? (saved?.repo ?? null) : null,
  };
}

/**
 * "Edit" on a generated image or video: the file (attached to the draft) with
 * each control set from its sidecar where it names an offered option, saving
 * to `repo`. No preset, since the values already came from one. A video opens
 * in Video mode, where an attached video is extended or edited.
 */
export function editStateFromSidecar(
  spec: ComposerSpec,
  values: Record<string, string>,
  repo: string | null,
  video = false,
): ComposerPanelState {
  return video
    ? stateFromSidecar(spec, values, repo, 0, { mode: VIDEO_MODE, videos: 1 })
    : stateFromSidecar(spec, values, repo, 1);
}

/** The mode a harness makes videos in. */
export const VIDEO_MODE = "video";

/**
 * The panel as a sidecar describes it, with `images` (and `videos`) attached:
 * what Regenerate sends again. A file with Generate / Edit modes uses the
 * image mode when images are attached; `mode` names one outright (Video), and
 * `picks` sets controls the sidecar keeps elsewhere (a video's first frame).
 */
export function stateFromSidecar(
  spec: ComposerSpec,
  values: Record<string, string>,
  repo: string | null,
  images: number,
  {
    mode: wanted,
    picks: given = {},
    videos = 0,
  }: { mode?: string; picks?: Record<string, string>; videos?: number } = {},
): ComposerPanelState {
  const mode =
    spec.modes.find((candidate) => candidate.id === wanted)?.id ??
    spec.modes.find((candidate) =>
      images > 0 ? candidate.requiresImage : !candidate.requiresImage,
    )?.id ??
    defaultMode(spec);
  const picks: Record<string, string> = {};
  resolve(spec, mode, { images, videos }, (control, offered) => {
    const value =
      given[control.id] ??
      (control.sidecarKey ? values[control.sidecarKey] : undefined);
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
    images,
    videos,
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
 * Records the attached image and video counts. In a file with an image mode
 * (`autoOnImage`), the first image switches to it and removing the last one
 * switches back to the default mode.
 */
export function followAttachments(
  state: ComposerPanelState,
  spec: ComposerSpec,
  images: number,
  videos = state.videos,
): ComposerPanelState {
  const next = { ...state, images, videos };
  if (state.images === 0 && images > 0) {
    const imageMode = spec.modes.find((mode) => mode.autoOnImage);
    return imageMode ? setMode(next, imageMode.id) : next;
  }
  if (state.images > 0 && images === 0) {
    return setMode(next, defaultMode(spec));
  }
  return next;
}

/** The picked options' rules for attached images. */
export function imageRules(
  state: ComposerPanelState,
  spec: ComposerSpec,
): { refs: boolean; max: { count: number; label: string } | null } {
  let refs = false;
  let max: { count: number; label: string } | null = null;
  for (const option of Object.values(resolvePanel(state, spec).options)) {
    if (!option) continue;
    if (option.imageRefs) refs = true;
    if (option.maxImages && (!max || option.maxImages < max.count)) {
      max = { count: option.maxImages, label: option.label };
    }
  }
  return { refs, max };
}

/** Why sending is blocked, or null. */
export function sendBlockReason(
  state: ComposerPanelState,
  spec: ComposerSpec,
): string | null {
  const mode = spec.modes.find((candidate) => candidate.id === state.mode);
  if (mode?.requiresImage && state.images === 0) {
    return `Attach an image to ${mode.label.toLowerCase()}`;
  }
  if (state.images > 0 && state.videos > 0 && followsVideos(spec)) {
    return "Attach images or a video, not both";
  }
  const { max } = imageRules(state, spec);
  if (max && state.images > max.count) {
    const images = max.count === 1 ? "1 image" : `${max.count} images`;
    return `${max.label} takes up to ${images}; remove ${state.images - max.count}`;
  }
  return null;
}

/** A panel with rules for attached videos takes images or a video. */
function followsVideos(spec: ComposerSpec): boolean {
  const names = (when?: Record<string, string[]>) => VIDEOS_KEY in (when ?? {});
  return spec.controls.some(
    (control) =>
      names(control.when) ||
      control.options.some((option) => names(option.when)),
  );
}

/**
 * Whether a control shows: in its modes, while its `when` holds (a menu only
 * some models have), and, for a pick of images, while any are attached.
 */
export function controlShown(
  control: ComposerControl,
  resolved: ResolvedPanel,
): boolean {
  if (!inMode(control, resolved.mode)) return false;
  if (VALUE_KINDS.has(control.kind) && !(control.id in resolved.values)) {
    return false;
  }
  return matches(control.when, resolved.values);
}

export type ComposerPayload = {
  v: 1;
  mode: string;
  controls: Record<string, string>;
};

/**
 * Every shown value control is sent with its current value; unset repo and
 * preset are left out.
 */
export function composerPayload(
  state: ComposerPanelState,
  spec: ComposerSpec,
): ComposerPayload {
  const resolved = resolvePanel(state, spec);
  const controls: Record<string, string> = {};
  for (const control of valueControls(spec)) {
    const value = resolved.values[control.id];
    if (value !== undefined && controlShown(control, resolved)) {
      controls[control.id] = value;
    }
  }
  const preset = presetControl(spec);
  const picked = activePreset(state, spec);
  if (preset && picked) controls[preset.id] = picked;
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
    mode: state.mode,
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
 * harness with an image mode, else one whose model list has the sidecar's
 * model (a repository file has no author), else the first such agent.
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
  values: Record<string, string> = {},
): { agent: Agent; harness: HarnessComposer } | null {
  const targets = agents.flatMap((agent) => {
    const harness = harnessComposerForAgent(composers, agent);
    return harness && takesImages(harness.composer) ? [{ agent, harness }] : [];
  });
  const author = authorPubkey?.toLowerCase();
  const model = values.model_id;
  const madeIt = (spec: ComposerSpec) =>
    spec.controls.some(
      (control) =>
        control.sidecarKey === "model_id" &&
        control.options.some((option) => option.value === model),
    );
  return (
    targets.find((target) => target.agent.pubkey.toLowerCase() === author) ??
    (model
      ? targets.find((target) => madeIt(target.harness.composer))
      : undefined) ??
    targets[0] ??
    null
  );
}

/** An image mode, or a model that takes attached images. */
export function takesImages(spec: ComposerSpec): boolean {
  return (
    spec.modes.some((mode) => mode.requiresImage) ||
    spec.controls.some((control) =>
      control.options.some((option) => option.maxImages),
    )
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
