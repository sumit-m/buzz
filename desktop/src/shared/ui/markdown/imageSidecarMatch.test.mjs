import assert from "node:assert/strict";
import { test } from "node:test";

import { findSidecarUrl, isImageSidecarFile } from "./imageSidecarMatch.ts";

const imeta = new Map([
  ["https://r/a.jpg", { filename: "339c.jpg", m: "image/jpeg" }],
  ["https://r/a.json", { filename: "339c.json", m: "application/json" }],
  ["https://r/notes.json", { filename: "notes.json", m: "application/json" }],
  ["https://r/b.png", { filename: "b.png", m: "image/png" }],
]);

test("an image finds the sidecar with its file name stem", () => {
  assert.equal(findSidecarUrl(imeta, "https://r/a.jpg"), "https://r/a.json");
  assert.equal(findSidecarUrl(imeta, "https://r/b.png"), null);
  assert.equal(findSidecarUrl(imeta, "https://r/missing.jpg"), null);
  assert.equal(findSidecarUrl(undefined, "https://r/a.jpg"), null);
});

test("only an image's sidecar is hidden as a file card", () => {
  assert.equal(isImageSidecarFile(imeta, "339c.json"), true);
  assert.equal(isImageSidecarFile(imeta, "notes.json"), false);
  assert.equal(isImageSidecarFile(imeta, "339c.txt"), false);
  assert.equal(isImageSidecarFile(undefined, "339c.json"), false);
});
