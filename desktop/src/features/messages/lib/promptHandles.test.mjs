import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assetGroups,
  assetIndex,
  findHandles,
  handleQueryAtEnd,
  IMAGES_CONTROL,
  imageEntries,
  matchAssets,
  uniqueHandles,
  withEntries,
} from "./promptHandles.ts";

const handles = (text, skip) => findHandles(text, skip).map((s) => s.handle);

test("findHandles finds words after a space, bracket or quote", () => {
  assert.deepEqual(
    handles('@ryantennis wearing (@niketrack), "@court.night".'),
    ["ryantennis", "niketrack", "court.night"],
  );
  const [span] = findHandles("a @b-c. d");
  assert.deepEqual(span, { start: 2, end: 6, handle: "b-c" });
});

test("findHandles skips emails, lone @ and Buzz mentions", () => {
  assert.deepEqual(handles("mail me@site.com @ now"), []);
  assert.deepEqual(handles("@Mage @ryantennis on court", ["Mage"]), [
    "ryantennis",
  ]);
  assert.deepEqual(handles("@Mage Bot @x", ["mage bot", "mage"]), ["x"]);
  assert.deepEqual(handles("@Mageling", ["Mage"]), ["Mageling"]);
});

test("uniqueHandles keeps first use, ignoring case", () => {
  assert.deepEqual(uniqueHandles(findHandles("@A @b @a @B @c")), [
    "A",
    "b",
    "c",
  ]);
});

test("handleQueryAtEnd reads the handle being typed", () => {
  assert.equal(handleQueryAtEnd("wearing @nik"), "nik");
  assert.equal(handleQueryAtEnd("@"), "");
  assert.equal(handleQueryAtEnd("me@nik"), null);
  assert.equal(handleQueryAtEnd("@nik done"), null);
});

const spec = {
  modes: [],
  controls: [
    { id: "model", kind: "list", label: "Model", options: [] },
    {
      id: "character",
      kind: "assets",
      label: "Character",
      options: [
        { value: "ryantennis", label: "ryan tennis" },
        { value: "annaswim", label: "anna" },
      ],
    },
    {
      id: "reference",
      kind: "assets",
      label: "Reference",
      options: [{ value: "niketrack", label: "niketrack", hint: "Outfit" }],
    },
  ],
};

test("assetIndex and matchAssets", () => {
  const index = assetIndex([spec]);
  assert.equal(index.size, 3);
  assert.equal(index.get("niketrack").control.id, "reference");
  assert.deepEqual(
    matchAssets("ryan", index).map((e) => e.option.value),
    ["ryantennis"],
  );
  assert.deepEqual(
    matchAssets("n", index).map((e) => e.option.value),
    ["niketrack", "ryantennis", "annaswim"],
  );
  assert.deepEqual(matchAssets("zzz", index), []);
  assert.equal(matchAssets("", index, 2).length, 2);
});

test("image entries name each image in order and join an asset index", () => {
  const entries = imageEntries(
    ["https://r/a.png", "https://r/b.png"],
    "source",
  );
  assert.deepEqual(
    entries.map((entry) => [entry.option.value, entry.option.label]),
    [
      ["image1", "Image 1"],
      ["image2", "Image 2"],
    ],
  );
  const assets = new Map([
    ["ryan", { control: { id: "character" }, option: { value: "ryan" } }],
  ]);
  const index = withEntries(assets, entries);
  assert.equal(index.get("image2").control, IMAGES_CONTROL);
  assert.equal(index.get("ryan").control.id, "character");
  assert.equal(withEntries(assets, []), assets);
});

test("assetGroups lists a menu's tabs in first-seen order", () => {
  const options = [
    { value: "altair", label: "Altair", group: "Male" },
    { value: "ara", label: "Ara", group: "Female" },
    { value: "atlas", label: "Atlas", group: "Male" },
  ];
  assert.deepEqual(
    assetGroups({ id: "voice", kind: "assets", label: "Voice", options }),
    ["Male", "Female"],
  );
  assert.deepEqual(
    assetGroups({
      id: "character",
      kind: "assets",
      label: "Character",
      options: [{ value: "a", label: "A" }],
    }),
    [],
  );
});
