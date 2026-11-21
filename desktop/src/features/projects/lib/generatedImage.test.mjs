import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canRegenerate,
  candidateRepositories,
  findRepository,
  folderOf,
  locationFromMatches,
  parseRepoValue,
  planRelocation,
  regenerateMessage,
  regenerateSetup,
  repoValueFor,
} from "./generatedImage.ts";

const repo = (id, dtag, owner = "ab", channelId = null) => ({
  id,
  dtag,
  owner,
  name: dtag,
  channelId,
});
const site = repo("r1", "site", "ab", "c1");
const art = repo("r2", "art", "cd", "c1");
const other = repo("r3", "other", "ef", "c2");

test("folders and repo values", () => {
  assert.equal(folderOf("assets/foxes/h1.jpg"), "assets/foxes/");
  assert.equal(folderOf("h1.jpg"), "");
  assert.deepEqual(parseRepoValue("ab/site:assets"), {
    owner: "ab",
    dtag: "site",
    folder: "assets/",
  });
  assert.deepEqual(parseRepoValue("site:/"), {
    owner: null,
    dtag: "site",
    folder: "",
  });
  assert.equal(parseRepoValue("no-colon"), null);
  assert.equal(findRepository([site, art], "CD/art"), art);
  assert.equal(findRepository([site, art], "site"), site);
  assert.equal(findRepository([site, art], "zz/site"), null);
  assert.equal(
    repoValueFor({
      repository: site,
      imagePath: "a/h1.jpg",
      sidecarPath: null,
    }),
    "ab/site:a/",
  );
});

test("candidates: viewed repo, saved repo, then the channel's", () => {
  const all = [site, art, other];
  assert.deepEqual(
    candidateRepositories(all, {
      channelId: "c1",
      current: null,
      originRepo: "ef/other",
    }).map((r) => r.id),
    ["r3", "r1", "r2"],
  );
  assert.deepEqual(
    candidateRepositories(all, {
      channelId: null,
      current: art,
      originRepo: "cd/art",
    }).map((r) => r.id),
    ["r2"],
  );
});

test("locationFromMatches prefers the viewed copy and finds the sidecar", () => {
  const matches = ["old/h1.jpg", "new/h1.jpg", "new/h1.json"];
  assert.deepEqual(locationFromMatches(site, matches, "h1.jpg", "new/h1.jpg"), {
    repository: site,
    imagePath: "new/h1.jpg",
    sidecarPath: "new/h1.json",
  });
  assert.equal(locationFromMatches(site, matches, "h1.jpg").sidecarPath, null);
  assert.equal(locationFromMatches(site, ["h1.json"], "h1.jpg"), null);
});

const at = (repository, imagePath, sidecarPath = null) => ({
  repository,
  imagePath,
  sidecarPath,
});

test("planRelocation: rename in one repo, copy and remove across repos", () => {
  const moved = planRelocation({
    attachments: null,
    folder: "art/",
    imageName: "h1.jpg",
    location: at(site, "assets/h1.jpg", "assets/h1.json"),
    target: site,
  });
  assert.deepEqual(moved.commits[0].renames, [
    { from: "assets/h1.jpg", to: "art/h1.jpg" },
    { from: "assets/h1.json", to: "art/h1.json" },
  ]);
  assert.equal(moved.commits[0].message, "Move h1.jpg to art/");
  assert.deepEqual(moved.destination, {
    repository: site,
    imagePath: "art/h1.jpg",
  });

  const across = planRelocation({
    attachments: null,
    folder: "",
    imageName: "h1.jpg",
    location: at(site, "assets/h1.jpg"),
    target: art,
  });
  assert.equal(across.commits.length, 2);
  assert.deepEqual(across.commits[0].adds, [
    { path: "h1.jpg", from: { repository: site, path: "assets/h1.jpg" } },
  ]);
  assert.equal(across.commits[0].repository, art);
  assert.deepEqual(across.commits[1].deletes, ["assets/h1.jpg"]);
  assert.equal(across.commits[1].message, "Move h1.jpg to art: /");

  assert.equal(
    planRelocation({
      attachments: null,
      folder: "assets/",
      imageName: "h1.jpg",
      location: at(site, "assets/h1.jpg"),
      target: site,
    }),
    null,
  );
});

test("planRelocation copies a chat image's uploads when it isn't saved", () => {
  const copied = planRelocation({
    attachments: {
      imageUrl: "https://r/media/i.jpg",
      sidecarUrl: "https://r/media/s.json",
    },
    folder: "art/",
    imageName: "h1.jpg",
    location: null,
    target: art,
  });
  assert.deepEqual(copied.commits[0].adds, [
    { path: "art/h1.jpg", url: "https://r/media/i.jpg" },
    { path: "art/h1.json", url: "https://r/media/s.json" },
  ]);
  assert.equal(
    planRelocation({
      attachments: null,
      folder: "art/",
      imageName: "h1.jpg",
      location: null,
      target: art,
    }),
    null,
  );
});

test("regenerate needs an origin, and each source's upload", () => {
  assert.equal(canRegenerate(null), false);
  assert.equal(
    canRegenerate({ mode: "generate", sources: [], repo: null }),
    true,
  );
  assert.equal(canRegenerate({ mode: "edit", sources: [], repo: null }), false);
  assert.equal(
    canRegenerate({
      mode: "edit",
      sources: [{ url: "https://r/m/a", x: "ab" }, { url: "https://r/m/b" }],
      repo: null,
    }),
    false,
  );
  assert.equal(
    canRegenerate({
      mode: "edit",
      sources: [
        { url: "https://r/m/a", x: "ab" },
        { url: "https://r/m/b", x: "cd" },
      ],
      repo: null,
    }),
    true,
  );

  const plain = regenerateMessage({
    agentName: "Mage",
    prompt: " a red\n fox ",
    sources: [],
  });
  assert.equal(plain.content, "@Mage a red fox");
  assert.equal(plain.mediaTags, undefined);

  const edit = regenerateMessage({
    agentName: "Mage",
    prompt: "the fox from @image1 on @image2",
    sources: [
      { url: "https://r/media/a.png", m: "image/png", x: "ab", dim: "9x9" },
      { url: "https://r/media/b.png", m: "image/png", x: "cd" },
    ],
  });
  assert.equal(
    edit.content,
    "@Mage the fox from @image1 on @image2\n![image](https://r/media/a.png)\n![image](https://r/media/b.png)",
  );
  assert.deepEqual(edit.mediaTags, [
    ["imeta", "url https://r/media/a.png", "m image/png", "x ab", "dim 9x9"],
    ["imeta", "url https://r/media/b.png", "m image/png", "x cd"],
  ]);
});

test("a video's Regenerate rebuilds Video mode with its frame or action", () => {
  const image = { url: "https://r/a.jpg", m: "image/jpeg", x: "a" };
  const video = { url: "https://r/v.mp4", m: "video/mp4", x: "v" };
  assert.deepEqual(
    regenerateSetup({
      mode: "video",
      sources: [image],
      frame: "1",
      repo: null,
    }),
    { images: 1, options: { mode: "video", picks: { frame: "1" }, videos: 0 } },
  );
  assert.deepEqual(
    regenerateSetup({
      mode: "video-extend",
      sources: [video],
      frame: null,
      repo: null,
    }),
    {
      images: 0,
      options: { mode: "video", picks: { action: "extend" }, videos: 1 },
    },
  );
  assert.deepEqual(
    regenerateSetup({
      mode: "edit",
      sources: [image, image],
      frame: null,
      repo: null,
    }),
    { images: 2, options: { picks: {}, videos: 0 } },
  );
  assert.equal(
    canRegenerate({ mode: "video", sources: [], frame: null, repo: null }),
    true,
  );
});
