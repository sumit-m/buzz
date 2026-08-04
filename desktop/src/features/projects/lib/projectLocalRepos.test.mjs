import assert from "node:assert/strict";
import { test } from "node:test";

import { hasLocalRepositoryCheckout, localRepoCandidates } from "./projectLocalRepos.ts";

const OWNER =
  "9857acd558b3115a773b1bb51e4de8d38c26751ff4ad679114158a8b28a56b35";

function project(overrides = {}) {
  return {
    dtag: "bee-game",
    cloneUrls: [`http://127.0.0.1:3000/git/${OWNER}/bee-game`],
    ...overrides,
  };
}

test("the bare repo name comes first, matching where a clone lands", () => {
  assert.deepEqual(localRepoCandidates(project()), [
    "bee-game",
  ]);
});

test("a checkout under the bare repo name is detected", () => {
  assert.equal(hasLocalRepositoryCheckout(project(), new Set(["bee-game"])), true);
});

test("an unrelated directory is not a checkout", () => {
  assert.equal(hasLocalRepositoryCheckout(project(), new Set(["other-repo"])), false);
});

test("an empty repos directory has no checkout", () => {
  assert.equal(hasLocalRepositoryCheckout(project(), new Set()), false);
});

test("a .git suffix on the clone URL is trimmed", () => {
  const withSuffix = project({
    cloneUrls: [`https://relay.example/git/${OWNER}/bee-game.git`],
  });
  assert.deepEqual(localRepoCandidates(withSuffix), [
    "bee-game",
  ]);
});

test("a project with no clone URL falls back to its dtag", () => {
  assert.deepEqual(localRepoCandidates(project({ cloneUrls: [] })), [
    "bee-game",
  ]);
});

test("a dtag differing from the clone URL keeps both candidates", () => {
  const renamed = project({ dtag: "bee-game-local" });
  assert.deepEqual(localRepoCandidates(renamed), [
    "bee-game",
    "bee-game-local",
  ]);
});

test("an unparseable clone URL does not throw", () => {
  const broken = project({ cloneUrls: ["not a url"] });
  assert.deepEqual(localRepoCandidates(broken), ["bee-game"]);
});
