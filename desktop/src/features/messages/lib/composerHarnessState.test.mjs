import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activePreset,
  applyPreset,
  composerPayload,
  composerTag,
  controlShown,
  editStateFromSidecar,
  editTargetFor,
  effectiveValue,
  followAttachments,
  harnessComposerForAgent,
  IMAGES_KEY,
  VIDEOS_KEY,
  imageRules,
  initialPanelState,
  optionsFor,
  pickValue,
  presetOptions,
  resolvePanel,
  scaledSize,
  sendBlockReason,
  setMode,
  shortestDuration,
  setRepo,
  stateFromSidecar,
  takesImages,
  toSavedState,
} from "./composerHarnessState.ts";

const spec = {
  modes: [
    { id: "generate", label: "Generate" },
    { id: "edit", label: "Edit", requiresImage: true, autoOnImage: true },
  ],
  controls: [
    {
      id: "model",
      kind: "list",
      label: "Model",
      default: "mango-v4",
      sidecarKey: "model_id",
      options: [
        { value: "mango-v4", label: "Mango 4" },
        { value: "mango-v2", label: "Mango 2" },
      ],
    },
    {
      id: "aspect",
      kind: "shapes",
      label: "Aspect ratio",
      default: "portrait",
      sidecarKey: "aspect_ratio",
      defaultByMode: { edit: "auto" },
      options: [
        { value: "auto", label: "Auto", modes: ["edit"] },
        { value: "portrait", label: "Portrait", size: [896, 1152] },
        { value: "square", label: "Square", size: [1024, 1024] },
      ],
    },
    {
      id: "res",
      kind: "segmented",
      label: "Resolution",
      default: "1K",
      sidecarKey: "resolution",
      defaultByMode: { edit: "auto" },
      options: [
        { value: "auto", label: "Auto", modes: ["edit"] },
        { value: "1K", label: "1K", scale: 1 },
        { value: "2K", label: "2K", scale: 2 },
      ],
    },
    {
      id: "preset",
      kind: "preset",
      label: "Preset",
      options: [
        { value: "logo", label: "logo", sets: { aspect: "square", res: "1K" } },
      ],
    },
    { id: "repo", kind: "repoFolder", label: "Save to repo", options: [] },
  ],
};
const control = (id) => spec.controls.find((c) => c.id === id);

test("defaults follow the mode, Auto only in Edit", () => {
  const state = initialPanelState(spec);
  assert.equal(state.mode, "generate");
  assert.equal(effectiveValue(state, control("aspect"), spec), "portrait");
  assert.deepEqual(
    optionsFor(control("res"), "generate").map((o) => o.value),
    ["1K", "2K"],
  );
  const edit = setMode(state, "edit");
  assert.equal(effectiveValue(edit, control("aspect"), spec), "auto");
  assert.equal(effectiveValue(edit, control("res"), spec), "auto");
});

test("explicit picks survive a mode switch; Auto falls back in Generate", () => {
  const edit = pickValue(
    pickValue(setMode(initialPanelState(spec), "edit"), spec, "res", "2K"),
    spec,
    "aspect",
    "auto",
  );
  const generate = setMode(edit, "generate");
  assert.equal(effectiveValue(generate, control("res"), spec), "2K");
  assert.equal(effectiveValue(generate, control("aspect"), spec), "portrait");
  assert.equal(
    effectiveValue(setMode(generate, "edit"), control("aspect"), spec),
    "auto",
  );
});

test("attachments drive the mode", () => {
  let state = initialPanelState(spec);
  state = followAttachments(state, spec, 1);
  assert.equal(state.mode, "edit");
  assert.equal(state.images, 1);
  state = followAttachments(state, spec, 2);
  assert.equal(state.mode, "edit");
  state = followAttachments(state, spec, 0);
  assert.equal(state.mode, "generate");
  assert.equal(state.images, 0);
});

test("Edit without an image is blocked", () => {
  const edit = setMode(initialPanelState(spec), "edit");
  assert.equal(sendBlockReason(edit, spec), "Attach an image to edit");
  assert.equal(sendBlockReason({ ...edit, images: 1 }, spec), null);
  assert.equal(sendBlockReason(initialPanelState(spec), spec), null);
});

const imageSpec = {
  modes: [{ id: "image", label: "Image" }],
  controls: [
    {
      id: "model",
      kind: "list",
      label: "Model",
      default: "mango-v4",
      options: [
        { value: "mango-v4", label: "Mango 4", maxImages: 3, imageRefs: true },
        { value: "z-image-turbo", label: "Z-Image Turbo", maxImages: 1 },
      ],
    },
    {
      id: "aspect",
      kind: "shapes",
      label: "Aspect",
      default: "portrait",
      defaultWithImages: "auto",
      options: [
        { value: "auto", label: "Auto", when: { [IMAGES_KEY]: ["attached"] } },
        { value: "portrait", label: "Portrait" },
      ],
    },
    {
      id: "character",
      kind: "assets",
      label: "Character",
      when: { model: ["mango-v4"] },
      options: [],
    },
  ],
};

test("Auto follows the attachments, not a mode", () => {
  let state = initialPanelState(imageSpec);
  const aspect = imageSpec.controls[1];
  assert.equal(effectiveValue(state, aspect, imageSpec), "portrait");
  assert.deepEqual(
    optionsFor(aspect, state.mode, resolvePanel(state, imageSpec).values).map(
      (o) => o.value,
    ),
    ["portrait"],
  );
  state = followAttachments(state, imageSpec, 2);
  assert.equal(state.mode, "image");
  assert.equal(effectiveValue(state, aspect, imageSpec), "auto");
  assert.equal(composerPayload(state, imageSpec).controls.aspect, "auto");
  assert.equal(IMAGES_KEY in composerPayload(state, imageSpec).controls, false);
  state = pickValue(state, imageSpec, "aspect", "auto");
  state = followAttachments(state, imageSpec, 0);
  assert.equal(effectiveValue(state, aspect, imageSpec), "portrait");
});

test("the picked model sets the image limit, image references and menus", () => {
  let state = followAttachments(initialPanelState(imageSpec), imageSpec, 3);
  assert.deepEqual(imageRules(state, imageSpec), {
    refs: true,
    max: { count: 3, label: "Mango 4" },
  });
  assert.equal(sendBlockReason(state, imageSpec), null);
  const character = imageSpec.controls[2];
  assert.equal(controlShown(character, resolvePanel(state, imageSpec)), true);
  state = pickValue(state, imageSpec, "model", "z-image-turbo");
  assert.equal(imageRules(state, imageSpec).refs, false);
  assert.equal(
    sendBlockReason(state, imageSpec),
    "Z-Image Turbo takes up to 1 image; remove 2",
  );
  assert.equal(controlShown(character, resolvePanel(state, imageSpec)), false);
  assert.equal(takesImages(imageSpec), true);
  assert.equal(takesImages({ modes: [], controls: [] }), false);
});

test("a preset sets every control it names, a later pick wins", () => {
  let state = applyPreset(initialPanelState(spec), spec, "logo");
  assert.equal(state.preset, "logo");
  assert.equal(effectiveValue(state, control("aspect"), spec), "square");
  state = pickValue(state, spec, "res", "2K");
  assert.equal(state.preset, "logo");
  assert.equal(effectiveValue(state, control("res"), spec), "2K");
  state = applyPreset(state, spec, null);
  assert.equal(state.preset, null);
  assert.equal(effectiveValue(state, control("aspect"), spec), "square");
});

test("the payload carries every value control and leaves unset preset and repo out", () => {
  const state = initialPanelState(spec);
  assert.deepEqual(composerPayload(state, spec), {
    v: 1,
    mode: "generate",
    controls: { model: "mango-v4", aspect: "portrait", res: "1K" },
  });
  const full = setRepo(applyPreset(state, spec, "logo"), "bee-garden:assets/");
  assert.deepEqual(composerPayload(full, spec).controls, {
    model: "mango-v4",
    aspect: "square",
    res: "1K",
    preset: "logo",
    repo: "bee-garden:assets/",
  });
  const [name, harness, json] = composerTag(
    "mage",
    composerPayload(full, spec),
  );
  assert.equal(name, "buzz-composer");
  assert.equal(harness, "mage");
  assert.equal(JSON.parse(json).controls.repo, "bee-garden:assets/");
});

test("restoring drops stale values; a mode that follows images starts at the default", () => {
  const saved = toSavedState(
    setRepo(
      pickValue(setMode(initialPanelState(spec), "edit"), spec, "res", "4K"),
      "x:y/",
    ),
    "a fox",
  );
  saved.picks.model = "mango-v2";
  saved.preset = "gone";
  const restored = initialPanelState(spec, saved);
  assert.equal(restored.mode, "generate");
  assert.deepEqual(restored.picks, { model: "mango-v2" });
  assert.equal(restored.preset, null);
  assert.equal(restored.repo, "x:y/");
  assert.equal(saved.prompt, "a fox");
});

test("shape sizes double at 2K", () => {
  const square = control("aspect").options[2];
  const state = initialPanelState(spec);
  assert.deepEqual(
    scaledSize(square, resolvePanel(state, spec), spec),
    [1024, 1024],
  );
  assert.deepEqual(
    scaledSize(
      square,
      resolvePanel(pickValue(state, spec, "res", "2K"), spec),
      spec,
    ),
    [2048, 2048],
  );
  assert.equal(
    scaledSize(control("aspect").options[0], resolvePanel(state, spec), spec),
    null,
  );
});

test("an agent matches its harness by id or resolved command", () => {
  const composers = [
    {
      harnessId: "mage",
      command: "C:\\Programs\\mage\\mage-agent.exe",
      composer: spec,
    },
  ];
  assert.ok(
    harnessComposerForAgent(composers, { runtime: "mage", agentCommand: "" }),
  );
  assert.ok(
    harnessComposerForAgent(composers, {
      runtime: null,
      agentCommand: "c:/programs/mage/mage-agent.exe",
    }),
  );
  assert.equal(
    harnessComposerForAgent(composers, {
      runtime: "claude",
      agentCommand: "claude-agent-acp",
    }),
    null,
  );
});

test("editStateFromSidecar starts the image mode from the image's settings", () => {
  const state = editStateFromSidecar(
    spec,
    { model_id: "mango-v2", aspect_ratio: "Square", resolution: "4K" },
    "site:img/",
  );
  assert.equal(state.mode, "edit");
  assert.deepEqual(state.picks, { model: "mango-v2", aspect: "square" });
  assert.equal(state.preset, null);
  assert.equal(state.repo, "site:img/");
  const res = spec.controls.find((control) => control.id === "res");
  assert.equal(effectiveValue(state, res, spec), "auto");
});

test("composerPayload leaves out a preset the harness no longer offers", () => {
  const state = { mode: "generate", picks: {}, preset: "gone", repo: null };
  assert.equal(composerPayload(state, spec).controls.preset, undefined);
  const kept = { ...state, preset: "logo" };
  assert.equal(composerPayload(kept, spec).controls.preset, "logo");
});

const byModel = {
  modes: spec.modes,
  controls: [
    {
      id: "model",
      kind: "list",
      label: "Model",
      default: "mango-v4",
      options: [
        { value: "mango-v4", label: "Mango 4", hint: "Slow" },
        {
          value: "flux2-dev",
          label: "FLUX 2 Dev",
          defaults: { aspect: "square", res: "1K" },
        },
      ],
    },
    {
      id: "aspect",
      kind: "shapes",
      label: "Aspect ratio",
      default: "portrait",
      options: [
        {
          value: "portrait",
          label: "Portrait",
          size: [896, 1152],
          sizes: [
            { when: { res: ["1K"] }, size: [896, 1152] },
            { when: { model: ["mango-v4"], res: ["2K"] }, size: [1792, 2304] },
            { when: { model: ["flux2-dev"], res: ["2K"] }, size: [1280, 1616] },
          ],
        },
        { value: "square", label: "Square", size: [1024, 1024] },
        {
          value: "cinema",
          label: "Cinema",
          size: [1344, 768],
          when: { model: ["mango-v4"] },
        },
      ],
    },
    {
      id: "res",
      kind: "segmented",
      label: "Resolution",
      default: "1K",
      sidecarKey: "resolution",
      options: [
        { value: "1K", label: "1K" },
        { value: "2K", label: "2K" },
        { value: "4K", label: "4K", when: { model: ["mango-v4"] } },
      ],
    },
  ],
};
const at = (id) => byModel.controls.find((c) => c.id === id);
const values = (state) => {
  const {
    [IMAGES_KEY]: _images,
    [VIDEOS_KEY]: _videos,
    ...controls
  } = resolvePanel(state, byModel).values;
  return controls;
};

test("a model switch keeps what the new model offers", () => {
  const untouched = pickValue(
    initialPanelState(byModel),
    byModel,
    "model",
    "flux2-dev",
  );
  assert.deepEqual(values(untouched), {
    model: "flux2-dev",
    aspect: "portrait",
    res: "1K",
  });
  const picked = pickValue(
    pickValue(initialPanelState(byModel), byModel, "res", "2K"),
    byModel,
    "model",
    "flux2-dev",
  );
  assert.equal(values(picked).res, "2K");
});

test("what the new model lacks becomes its default, and stays on switching back", () => {
  let state = pickValue(initialPanelState(byModel), byModel, "res", "4K");
  state = pickValue(state, byModel, "aspect", "cinema");
  assert.deepEqual(
    optionsFor(at("res"), "generate", values(state)).map((o) => o.value),
    ["1K", "2K", "4K"],
  );
  state = pickValue(state, byModel, "model", "flux2-dev");
  assert.deepEqual(values(state), {
    model: "flux2-dev",
    aspect: "square",
    res: "1K",
  });
  state = pickValue(state, byModel, "model", "mango-v4");
  assert.deepEqual(values(state), {
    model: "mango-v4",
    aspect: "square",
    res: "1K",
  });
});

test("a pick only the mode hides is dropped, not replaced", () => {
  let state = pickValue(
    setMode(initialPanelState(spec), "edit"),
    spec,
    "res",
    "auto",
  );
  state = pickValue(setMode(state, "generate"), spec, "model", "mango-v2");
  assert.equal(state.picks.res, undefined);
  assert.equal(
    effectiveValue(setMode(state, "edit"), control("res"), spec),
    "auto",
  );
});

test("sizes come from the variant for the model and resolution", () => {
  const portrait = at("aspect").options[0];
  const size = (model, res) => {
    let state = pickValue(initialPanelState(byModel), byModel, "model", model);
    state = pickValue(state, byModel, "res", res);
    return scaledSize(portrait, resolvePanel(state, byModel), byModel);
  };
  assert.deepEqual(size("mango-v4", "1K"), [896, 1152]);
  assert.deepEqual(size("mango-v4", "2K"), [1792, 2304]);
  assert.deepEqual(size("flux2-dev", "2K"), [1280, 1616]);
});

test("a sidecar's resolution matches regardless of case", () => {
  const state = editStateFromSidecar(byModel, { resolution: "2k" }, null);
  assert.equal(state.picks.res, "2K");
});

const videoSpec = {
  modes: [
    { id: "image", label: "Image" },
    { id: "video", label: "Video" },
  ],
  controls: [
    {
      id: "model",
      kind: "list",
      label: "Model",
      options: [
        { value: "img", label: "Image model", modes: ["image"] },
        {
          value: "v15",
          label: "Video 1.5",
          modes: ["video"],
          when: { [VIDEOS_KEY]: ["none"] },
        },
        { value: "v10", label: "Video 1.0", modes: ["video"] },
      ],
    },
    {
      id: "action",
      kind: "segmented",
      label: "Action",
      modes: ["video"],
      when: { [VIDEOS_KEY]: ["attached"] },
      options: [
        { value: "extend", label: "Extend" },
        { value: "edit", label: "Edit" },
      ],
    },
    {
      id: "frame",
      kind: "imagePick",
      label: "Frame",
      modes: ["video"],
      default: "1",
      options: [],
    },
    {
      id: "res",
      kind: "segmented",
      label: "Resolution",
      options: [
        { value: "720p", label: "720p" },
        {
          value: "1080p",
          label: "1080p",
          when: { [IMAGES_KEY]: ["none", "one"], frame: ["1"] },
        },
      ],
    },
    {
      id: "count",
      kind: "number",
      label: "Images",
      modes: ["image"],
      min: 1,
      max: 10,
      default: "1",
      options: [],
    },
    {
      id: "duration",
      kind: "number",
      label: "Duration",
      modes: ["video"],
      min: 1,
      max: 15,
      default: "8",
      unit: "s",
      options: [],
    },
  ],
};

test("modes keep their own controls; numbers resolve and clamp to their range", () => {
  let state = initialPanelState(videoSpec);
  assert.deepEqual(composerPayload(state, videoSpec).controls, {
    model: "img",
    res: "720p",
    count: "1",
  });
  state = pickValue(state, videoSpec, "count", "4");
  state = setMode(state, "video");
  assert.deepEqual(composerPayload(state, videoSpec).controls, {
    model: "v15",
    res: "720p",
    duration: "8",
  });
  state = pickValue(state, videoSpec, "duration", "12");
  assert.equal(
    pickValue(state, videoSpec, "duration", "40").picks.duration,
    undefined,
  );
  state = setMode(state, "image");
  assert.equal(composerPayload(state, videoSpec).controls.count, "4");
  assert.equal(
    initialPanelState(videoSpec, { picks: { duration: "99", count: "3" } })
      .picks.duration,
    undefined,
  );
});

test("a pick of images follows the attachments and gates other options", () => {
  let state = setMode(initialPanelState(videoSpec), "video");
  const offered = (s) =>
    optionsFor(
      videoSpec.controls.find((c) => c.id === "res"),
      s.mode,
      resolvePanel(s, videoSpec).values,
      s.images,
    ).map((o) => o.value);
  assert.equal("frame" in composerPayload(state, videoSpec).controls, false);
  assert.deepEqual(offered(state), ["720p", "1080p"]);
  state = followAttachments(state, videoSpec, 1);
  assert.equal(composerPayload(state, videoSpec).controls.frame, "1");
  assert.deepEqual(offered(state), ["720p", "1080p"]);
  assert.deepEqual(offered(pickValue(state, videoSpec, "frame", "none")), [
    "720p",
  ]);
  state = followAttachments(state, videoSpec, 3);
  assert.deepEqual(offered(state), ["720p"]);
  assert.deepEqual(
    optionsFor(videoSpec.controls[2], "video", {}, 2).map((o) => o.label),
    ["None", "Image 1", "Image 2"],
  );
});

test("a video attached shows its own controls; images with it block send", () => {
  let state = followAttachments(
    setMode(initialPanelState(videoSpec), "video"),
    videoSpec,
    0,
    1,
  );
  assert.deepEqual(composerPayload(state, videoSpec).controls, {
    model: "v10",
    action: "extend",
    res: "720p",
    duration: "8",
  });
  assert.equal(sendBlockReason(state, videoSpec), null);
  state = followAttachments(state, videoSpec, 2, 1);
  assert.equal(
    sendBlockReason(state, videoSpec),
    "Attach images or a video, not both",
  );
});

test("presets for one mode are offered and sent only in that mode", () => {
  const spec = {
    ...videoSpec,
    controls: [
      ...videoSpec.controls,
      {
        id: "preset",
        kind: "preset",
        label: "Preset",
        options: [
          { value: "logo", label: "logo", modes: ["image"], sets: {} },
          { value: "any", label: "any", sets: {} },
        ],
      },
    ],
  };
  let state = applyPreset(initialPanelState(spec), spec, "logo");
  assert.deepEqual(
    presetOptions(spec, "image").map((o) => o.value),
    ["logo", "any"],
  );
  assert.deepEqual(
    presetOptions(spec, "video").map((o) => o.value),
    ["any"],
  );
  assert.equal(composerPayload(state, spec).controls.preset, "logo");
  state = setMode(state, "video");
  assert.equal(activePreset(state, spec), null);
  assert.equal("preset" in composerPayload(state, spec).controls, false);
});

test("a video's sidecar opens Video mode for Edit and Regenerate", () => {
  const values = { model_id: "v10", duration: "4" };
  const edit = editStateFromSidecar(videoSpec, values, null, true);
  assert.equal(edit.mode, "video");
  assert.equal(edit.videos, 1);
  assert.equal(composerPayload(edit, videoSpec).controls.action, "extend");
  const again = stateFromSidecar(videoSpec, { model_id: "v15" }, null, 1, {
    mode: "video",
    picks: { frame: "none" },
  });
  assert.equal(again.mode, "video");
  assert.equal(composerPayload(again, videoSpec).controls.frame, "none");
});

test("restoring brings back a mode that does not follow attachments", () => {
  const video = pickValue(
    pickValue(
      setMode(initialPanelState(videoSpec), "video"),
      videoSpec,
      "duration",
      "3",
    ),
    videoSpec,
    "res",
    "720p",
  );
  const saved = toSavedState(video, "a ship");
  const restored = initialPanelState(videoSpec, saved);
  assert.equal(restored.mode, "video");
  assert.equal(restored.picks.duration, "3");
  assert.equal(restored.picks.res, "720p");
  assert.equal(
    initialPanelState(videoSpec, { ...saved, mode: "gone" }).mode,
    "image",
  );
  assert.equal(initialPanelState(videoSpec, { prompt: "old" }).mode, "image");
});

test("an edit without an author goes to the agent whose model made the file", () => {
  const harness = (id, model) => ({
    harnessId: id,
    command: id,
    composer: {
      modes: [{ id: "edit", label: "Edit", requiresImage: true }],
      controls: [
        {
          id: "model",
          kind: "list",
          label: "Model",
          sidecarKey: "model_id",
          options: [{ value: model, label: model }],
        },
      ],
    },
  });
  const composers = [
    harness("mage", "mango-v4"),
    harness("imagine", "grok-imagine-video"),
  ];
  const agents = [
    { pubkey: "AA", runtime: "mage", agentCommand: "" },
    { pubkey: "BB", runtime: "imagine", agentCommand: "" },
  ];
  const pick = (author, values) =>
    editTargetFor(composers, agents, author, values)?.agent.pubkey;
  assert.equal(pick(null, { model_id: "grok-imagine-video" }), "BB");
  assert.equal(pick("aa", { model_id: "grok-imagine-video" }), "AA");
  assert.equal(pick(null, { model_id: "other" }), "AA");
  assert.equal(pick(null), "AA");
});

test("Extend is blocked on a video shorter than its minimum", () => {
  const spec = structuredClone(videoSpec);
  spec.controls.find((c) => c.id === "action").options[0].minVideoSeconds = 2;
  const attached = followAttachments(
    setMode(initialPanelState(spec), "video"),
    spec,
    0,
    1,
  );
  assert.equal(
    sendBlockReason(attached, spec, 1.04),
    "Input video must be at least 2s long, the attached video length is 1s",
  );
  assert.equal(sendBlockReason(attached, spec, 2), null);
  assert.equal(sendBlockReason(attached, spec, null), null);
  assert.equal(
    sendBlockReason(pickValue(attached, spec, "action", "edit"), spec, 1),
    null,
  );
});

test("shortestDuration reads only videos with a known length", () => {
  assert.equal(
    shortestDuration([
      { type: "video/mp4", duration: 6 },
      { type: "image/png", duration: 0.5 },
      { type: "video/mp4", duration: 1.5 },
      { type: "video/mp4" },
    ]),
    1.5,
  );
  assert.equal(shortestDuration([{ type: "video/mp4" }]), null);
});
