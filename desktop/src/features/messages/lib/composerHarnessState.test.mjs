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
  assert.equal(effectiveValue(state, control("aspect")), "portrait");
  assert.deepEqual(
    optionsFor(control("res"), "generate").map((o) => o.value),
    ["1K", "2K"],
  );
  const edit = setMode(state, "edit");
  assert.equal(effectiveValue(edit, control("aspect")), "auto");
  assert.equal(effectiveValue(edit, control("res")), "auto");
});

test("explicit picks survive a mode switch; Auto falls back in Generate", () => {
  const edit = pickValue(
    pickValue(setMode(initialPanelState(spec), "edit"), "res", "2K"),
    "aspect",
    "auto",
  );
  const generate = setMode(edit, "generate");
  assert.equal(effectiveValue(generate, control("res")), "2K");
  assert.equal(effectiveValue(generate, control("aspect")), "portrait");
  assert.equal(
    effectiveValue(setMode(generate, "edit"), control("aspect")),
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
  assert.equal(effectiveValue(state, control("aspect")), "square");
  state = pickValue(state, "res", "2K");
  assert.equal(state.preset, "logo");
  assert.equal(effectiveValue(state, control("res")), "2K");
  state = applyPreset(state, spec, null);
  assert.equal(state.preset, null);
  assert.equal(effectiveValue(state, control("aspect")), "square");
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
      pickValue(setMode(initialPanelState(spec), "edit"), "res", "4K"),
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
  assert.deepEqual(scaledSize(square, state, spec), [1024, 1024]);
  assert.deepEqual(
    scaledSize(square, pickValue(state, "res", "2K"), spec),
    [2048, 2048],
  );
  assert.equal(scaledSize(control("aspect").options[0], state, spec), null);
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
  assert.equal(effectiveValue(state, res), "auto");
});

test("composerPayload leaves out a preset the harness no longer offers", () => {
  const state = { mode: "generate", picks: {}, preset: "gone", repo: null };
  assert.equal(composerPayload(state, spec).controls.preset, undefined);
  const kept = { ...state, preset: "logo" };
  assert.equal(composerPayload(kept, spec).controls.preset, "logo");
});
