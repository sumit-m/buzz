import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../../../preview-features.json", import.meta.url),
    "utf8",
  ),
);

test("existing Projects and Workflows experiments remain unchanged", () => {
  // LOCAL DIVERGENCE: `defaultEnabled` is compared separately in
  // `manifestDefaults.test.mjs` — this build ships Projects and Pulse on so
  // they survive a dev reset, which upstream does not. Everything else about
  // these two entries is still pinned here.
  const existing = Object.fromEntries(
    manifest.features
      .filter(({ id }) => id === "projects" || id === "workflows")
      .map(({ defaultEnabled: _defaultEnabled, ...feature }) => [
        feature.id,
        feature,
      ]),
  );

  assert.deepEqual(existing, {
    projects: {
      id: "projects",
      name: "Projects",
      description: "Git repository browser and collaboration",
      platforms: ["desktop"],
    },
    workflows: {
      id: "workflows",
      name: "Workflows",
      description: "YAML-defined automations with approval gates",
      platforms: ["desktop"],
    },
  });
});
