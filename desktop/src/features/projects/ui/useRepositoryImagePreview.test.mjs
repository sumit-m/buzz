import assert from "node:assert/strict";
import { test } from "node:test";

import { imageMimeForPath } from "./useRepositoryImagePreview.ts";

test("imageMimeForPath maps image extensions case-insensitively", () => {
  assert.equal(imageMimeForPath("assets/fox.JPG"), "image/jpeg");
  assert.equal(imageMimeForPath("a/b.png"), "image/png");
  assert.equal(imageMimeForPath("logo.svg"), "image/svg+xml");
});

test("imageMimeForPath ignores other files", () => {
  assert.equal(imageMimeForPath("assets/fox.json"), null);
  assert.equal(imageMimeForPath("png"), null);
  assert.equal(imageMimeForPath("README"), null);
});
