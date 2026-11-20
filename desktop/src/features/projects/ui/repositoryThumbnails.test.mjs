import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changedImages,
  requestThumbnail,
  thumbnailQuery,
} from "./repositoryThumbnails.ts";

const thumb = (path) => ({
  path,
  width: 1,
  height: 1,
  dataUrl: `data:${path}`,
});
const file = (path, hash = "c1") => ({
  path,
  kind: "file",
  size: 1,
  previewContent: null,
  lastChangedAt: 1,
  latestCommit: hash ? { hash } : null,
});

function recordingLoad() {
  const calls = [];
  const load = async (paths) => {
    calls.push(paths);
    return paths.filter((path) => !path.startsWith("bad")).map(thumb);
  };
  return { calls, load };
}

test("requests in one tick share one load per source", async () => {
  const first = recordingLoad();
  const second = recordingLoad();
  const results = await Promise.all([
    requestThumbnail("a", first.load, "one.png"),
    requestThumbnail("a", first.load, "bad.png"),
    requestThumbnail("b", second.load, "two.png"),
    requestThumbnail("a", first.load, "one.png"),
  ]);
  assert.deepEqual(first.calls, [["one.png", "bad.png"]]);
  assert.deepEqual(second.calls, [["two.png"]]);
  assert.deepEqual(results, [
    thumb("one.png"),
    null,
    thumb("two.png"),
    thumb("one.png"),
  ]);
});

test("a large batch is split into loads of at most 300", async () => {
  const { calls, load } = recordingLoad();
  const paths = Array.from({ length: 305 }, (_, i) => `${i}.png`);
  await Promise.all(paths.map((path) => requestThumbnail("big", load, path)));
  assert.deepEqual(
    calls.map((chunk) => chunk.length),
    [300, 5],
  );
});

test("a failed load rejects every request in it", async () => {
  const load = async () => {
    throw new Error("offline");
  };
  await assert.rejects(requestThumbnail("down", load, "x.png"), /offline/);
});

test("the cache key follows the commit that last changed the image", () => {
  const source = { cacheKey: ["repo", "remote"], load: async () => null };
  assert.deepEqual(thumbnailQuery(source, file("a.png", "c2")).queryKey, [
    "project-repository-thumbnail",
    "repo",
    "remote",
    "a.png",
    "c2",
  ]);
  assert.equal(thumbnailQuery(source, file("a.png")).enabled, false);
  assert.equal(thumbnailQuery(source, file("a.png", null)).queryKey.at(-1), 1);
});

test("changedImages lists new and changed images only", () => {
  const before = [file("a.png"), file("b.png"), file("notes.md")];
  const after = [
    file("a.png"),
    file("b.png", "c2"),
    file("notes.md", "c2"),
    file("new/c.jpg", "c2"),
    file("new/c.json", "c2"),
  ];
  assert.deepEqual(
    changedImages(before, after).map((entry) => entry.path),
    ["b.png", "new/c.jpg"],
  );
});
