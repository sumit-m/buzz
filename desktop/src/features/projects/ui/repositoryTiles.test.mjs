import assert from "node:assert/strict";
import { test } from "node:test";

import { splitTileEntries } from "./repositoryTiles.ts";

const file = (name) => ({ name, path: `assets/${name}`, type: "file" });
const dir = (name) => ({ name, path: `assets/${name}`, type: "directory" });

test("splitTileEntries puts images in the grid and hides their sidecars", () => {
  const { images, others } = splitTileEntries([
    dir("old"),
    file("fox.jpg"),
    file("fox.json"),
    file("cat.PNG"),
    file("cat.json"),
    file("notes.json"),
    file("README.md"),
  ]);
  assert.deepEqual(
    images.map((entry) => entry.name),
    ["fox.jpg", "cat.PNG"],
  );
  assert.deepEqual(
    others.map((entry) => entry.name),
    ["old", "notes.json", "README.md"],
  );
});

test("splitTileEntries keeps a folder named like an image's sidecar", () => {
  const { others } = splitTileEntries([file("fox.jpg"), dir("fox.json")]);
  assert.deepEqual(
    others.map((entry) => entry.name),
    ["fox.json"],
  );
});
