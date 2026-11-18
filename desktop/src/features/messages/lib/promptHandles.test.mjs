import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assetIndex,
  findHandles,
  handleQueryAtEnd,
  matchAssets,
  uniqueHandles,
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
