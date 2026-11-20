import assert from "node:assert/strict";
import { test } from "node:test";

import {
  existingFolder,
  freshFile,
  isFolderPath,
  parentPath,
} from "./repositoryNavigation.ts";

const file = (path, changed = 1) => ({
  path,
  kind: "file",
  size: 10,
  previewContent: null,
  lastChangedAt: changed,
  latestCommit: null,
});

const files = [file("a.md"), file("art/cats/one.jpg"), file("art/two.jpg")];

test("parent of a top-level file is the root", () => {
  assert.equal(parentPath("a.md"), "");
  assert.equal(parentPath("art/cats/one.jpg"), "art/cats");
});

test("a folder is a path some file lives under", () => {
  assert.equal(isFolderPath(files, ""), true);
  assert.equal(isFolderPath(files, "art/cats"), true);
  assert.equal(isFolderPath(files, "art/two.jpg"), false);
  assert.equal(isFolderPath(files, "ar"), false);
});

test("the open file stays the same object when a new file arrives", () => {
  const open = files[2];
  const refreshed = [
    ...files.map((entry) => ({ ...entry })),
    file("art/three.jpg"),
  ];
  assert.equal(freshFile(refreshed, open), open);
});

test("the open file takes the new list's details when it changed", () => {
  const refreshed = [file("art/two.jpg", 2)];
  assert.equal(freshFile(refreshed, files[2]), refreshed[0]);
});

test("the open file closes once it is gone", () => {
  assert.equal(freshFile([file("a.md")], files[2]), null);
  assert.equal(freshFile(files, null), null);
});

test("a folder that lost its files falls back to its nearest ancestor", () => {
  assert.equal(existingFolder(files, "art/cats"), "art/cats");
  assert.equal(existingFolder([file("art/two.jpg")], "art/cats"), "art");
  assert.equal(existingFolder([file("a.md")], "art/cats"), "");
});
