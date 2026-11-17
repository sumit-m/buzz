import assert from "node:assert/strict";
import { test } from "node:test";

import {
  folderSuggestions,
  foldersFromFilePaths,
  normalizeFolder,
} from "./composerFolderSuggestions.ts";

const folders = [
  "assets",
  "assets/foxes",
  "assets/foxes/red",
  "img",
  "img/hero",
  "docs",
];

test("normalizeFolder", () => {
  assert.equal(normalizeFolder("art\\foxes"), "art/foxes/");
  assert.equal(normalizeFolder("./art//foxes/"), "art/foxes/");
  assert.equal(normalizeFolder("/"), "");
  assert.equal(normalizeFolder("  "), "");
});

test("no query: root, then two levels, recent first", () => {
  const rows = folderSuggestions(folders, "", ["img/hero/"]);
  assert.deepEqual(rows, [
    { kind: "root", path: "" },
    { kind: "folder", path: "img/hero/" },
    { kind: "folder", path: "assets/" },
    { kind: "folder", path: "assets/foxes/" },
    { kind: "folder", path: "docs/" },
    { kind: "folder", path: "img/" },
  ]);
});

test("typing filters across all depths and offers a new folder", () => {
  assert.deepEqual(
    folderSuggestions(folders, "foxes").map((row) => row.path),
    ["assets/foxes/", "assets/foxes/red/", "foxes/"],
  );
  const existing = folderSuggestions(folders, "assets/foxes/red");
  assert.deepEqual(existing, [{ kind: "folder", path: "assets/foxes/red/" }]);
  assert.equal(folderSuggestions(folders, "art/new").at(-1).kind, "create");
});

test("at most 50 folder rows", () => {
  const many = Array.from(
    { length: 80 },
    (_, i) => `f${String(i).padStart(2, "0")}`,
  );
  const rows = folderSuggestions(many, "");
  assert.equal(rows.filter((row) => row.kind === "folder").length, 50);
});

test("folders from a file list", () => {
  assert.deepEqual(
    foldersFromFilePaths(["README.md", "a/b/c.jpg", "a/d.png"]),
    ["a", "a/b"],
  );
});
