import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// LOCAL: guards the default-on preview features against an upstream rebase.
// `preview-features.json` is upstream's file, and the enabled state a user
// toggles lives in local storage — which `just reset` wipes. So the manifest
// default is the only thing that survives a reset, and if a rebase drops these
// flags the symptom is silent: Projects and Pulse quietly go back to needing a
// manual toggle after every wipe. Fail loudly here instead.

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../preview-features.json", import.meta.url),
    ),
    "utf8",
  ),
);

function feature(id) {
  const found = manifest.features.find((entry) => entry.id === id);
  assert.ok(found, `preview-features.json no longer defines "${id}"`);
  return found;
}

for (const id of ["projects", "pulse"]) {
  test(`${id} ships enabled by default`, () => {
    assert.equal(
      feature(id).defaultEnabled,
      true,
      `"${id}" must set defaultEnabled so it survives a dev reset`,
    );
  });
}

test("the other preview features stay opt-in", () => {
  // Only these two were asked for. A rebase that flips the rest on should be a
  // deliberate decision, not something that rides in unnoticed.
  for (const entry of manifest.features) {
    if (entry.id === "projects" || entry.id === "pulse") continue;
    assert.notEqual(
      entry.defaultEnabled,
      true,
      `"${entry.id}" became default-on without being asked for`,
    );
  }
});
