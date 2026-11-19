import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_REPOSITORY_SORT,
  readRepositorySort,
  sortRepositoryEntries,
  writeRepositorySort,
} from "./repositorySort.ts";

const file = (path, { size = null, changed = null, created = null } = {}) => ({
  type: "file",
  name: path.split("/").pop(),
  path,
  size,
  lastChangedAt: changed,
  file: { path, createdAt: created },
});
const folder = (path, changed = null) => ({
  type: "directory",
  name: path.split("/").pop(),
  path,
  size: null,
  lastChangedAt: changed,
});

const entries = [
  file("b.jpg", { size: 300, changed: 20, created: 5 }),
  folder("zeta", 30),
  file("a.md", { size: 100, changed: 40, created: null }),
  folder("alpha", 10),
  file("c.png", { size: 200, changed: 10, created: 9 }),
];
const files = [
  ...entries.filter((e) => e.type === "file").map((e) => e.file),
  { path: "alpha/x.jpg", createdAt: 7 },
  { path: "alpha/deep/y.jpg", createdAt: 2 },
  { path: "zeta/z.jpg", createdAt: 8 },
];
const order = (sort) =>
  sortRepositoryEntries(entries, files, sort).map((e) => e.name);

test("name sorts each way with folders first", () => {
  assert.deepEqual(order(DEFAULT_REPOSITORY_SORT), [
    "alpha",
    "zeta",
    "a.md",
    "b.jpg",
    "c.png",
  ]);
  assert.deepEqual(order({ field: "name", direction: "desc" }), [
    "zeta",
    "alpha",
    "c.png",
    "b.jpg",
    "a.md",
  ]);
});

test("last changed and size", () => {
  assert.deepEqual(order({ field: "lastChanged", direction: "desc" }), [
    "zeta",
    "alpha",
    "a.md",
    "b.jpg",
    "c.png",
  ]);
  assert.deepEqual(order({ field: "size", direction: "asc" }), [
    "alpha",
    "zeta",
    "a.md",
    "c.png",
    "b.jpg",
  ]);
});

test("created: folders by their oldest file, missing dates last", () => {
  assert.deepEqual(order({ field: "created", direction: "asc" }), [
    "alpha",
    "zeta",
    "b.jpg",
    "c.png",
    "a.md",
  ]);
  assert.deepEqual(order({ field: "created", direction: "desc" }), [
    "zeta",
    "alpha",
    "c.png",
    "b.jpg",
    "a.md",
  ]);
});

test("the choice is remembered and bad values fall back", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  assert.deepEqual(readRepositorySort(), DEFAULT_REPOSITORY_SORT);
  writeRepositorySort({ field: "size", direction: "desc" });
  assert.deepEqual(readRepositorySort(), { field: "size", direction: "desc" });
  store.set("buzz.projects.repositoryFiles.sort", '{"field":"colour"}');
  assert.deepEqual(readRepositorySort(), DEFAULT_REPOSITORY_SORT);
  delete globalThis.localStorage;
});
