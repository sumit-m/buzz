import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPreset,
  composerPayload,
  composerTag,
  editStateFromSidecar,
  effectiveValue,
  followAttachments,
  harnessComposerForAgent,
  initialPanelState,
  optionsFor,
  pickValue,
  resolvePanel,
  scaledSize,
  sendBlockReason,
  setMode,
  setRepo,
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
  state = followAttachments(state, spec, 0, 1);
  assert.equal(state.mode, "edit");
  state = followAttachments(state, spec, 1, 2);
  assert.equal(state.mode, "edit");
  state = followAttachments(state, spec, 2, 0);
  assert.equal(state.mode, "generate");
});

test("Edit without an image is blocked", () => {
  const edit = setMode(initialPanelState(spec), "edit");
  assert.equal(sendBlockReason(edit, spec, 0), "Attach an image to edit");
  assert.equal(sendBlockReason(edit, spec, 1), null);
  assert.equal(sendBlockReason(initialPanelState(spec), spec, 0), null);
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

test("restoring drops stale values and always starts in the default mode", () => {
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
const values = (state) => resolvePanel(state, byModel).values;

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
