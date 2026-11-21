import assert from "node:assert/strict";
import { test } from "node:test";

import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";

import {
  HARNESS_IMAGE_REF_NODE_NAME,
  HarnessImageRefNode,
  imageRefContent,
  syncImageRefsTransaction,
} from "./harnessImageRefNode.ts";
import { buildPlainTextProjection } from "./plainTextProjection.ts";

const schema = getSchema([StarterKit, HarnessImageRefNode]);
const images = [
  { url: "https://r/a.png", thumb: "https://r/a.png" },
  { url: "https://r/b.png", thumb: "https://r/b.png" },
  { url: "https://r/c.png", thumb: "https://r/c.png" },
];

function stateWith(content) {
  return EditorState.create({
    schema,
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content }],
    }),
  });
}

function refs(state) {
  const found = [];
  state.doc.descendants((node) => {
    if (node.type.name === HARNESS_IMAGE_REF_NODE_NAME) {
      found.push([node.attrs.url, node.attrs.index]);
    }
  });
  return found;
}

const prompt = () =>
  stateWith([
    { type: "text", text: "fox from " },
    ...imageRefContent(images, 0),
    { type: "text", text: "on " },
    ...imageRefContent(images, 2),
  ]);

test("an image reference reads @image{index} as plain text", () => {
  const state = prompt();
  assert.equal(
    buildPlainTextProjection(state.doc).text,
    "fox from @image1 on @image3 ",
  );
  assert.equal(syncImageRefsTransaction(state, images), null);
});

test("references renumber when an earlier image goes, and go with their own", () => {
  let state = prompt();
  state = state.apply(syncImageRefsTransaction(state, images.slice(1)));
  assert.deepEqual(refs(state), [["https://r/c.png", 2]]);
  assert.equal(
    buildPlainTextProjection(state.doc).text,
    "fox from on @image2 ",
  );
});
