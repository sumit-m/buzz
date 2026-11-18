import assert from "node:assert/strict";
import test from "node:test";

import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";

import {
  handleQueryAt,
  harnessHandlesKey,
  harnessHandlesPlugin,
  removeHandleTransaction,
} from "./harnessHandlesPlugin.ts";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    codeBlock: { group: "block", content: "text*", code: true },
    hardBreak: { group: "inline", inline: true },
    text: { group: "inline" },
  },
});

function stateOf(blocks, caret, plugins = []) {
  const doc = schema.node(
    "doc",
    null,
    blocks.map(([type, parts]) =>
      schema.node(
        type,
        null,
        parts.map((part) =>
          part === "<br>" ? schema.node("hardBreak") : schema.text(part),
        ),
      ),
    ),
  );
  const state = EditorState.create({ doc, plugins });
  return caret === undefined
    ? state
    : state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, caret)),
      );
}

const textOf = (state) => state.doc.textBetween(0, state.doc.content.size, "|");

test("handleQueryAt reads the handle before the caret", () => {
  const text = "@Mage hi @nik";
  const state = stateOf([["paragraph", [text]]], 1 + text.length);
  assert.deepEqual(handleQueryAt(state), { query: "nik", from: 10, to: 14 });
  assert.equal(handleQueryAt(stateOf([["paragraph", ["a @nik x"]]], 9)), null);
  assert.equal(handleQueryAt(stateOf([["codeBlock", ["@nik"]]], 5)), null);
});

test("removeHandleTransaction deletes each use and one following space", () => {
  const state = stateOf([
    ["paragraph", ["@Mage @ryan in @nike ", "<br>", "@ryan, @RYAN"]],
  ]);
  const next = state.apply(removeHandleTransaction(state, "ryan", ["Mage"]));
  assert.equal(textOf(next), "@Mage in @nike , ");
  const kept = state.apply(removeHandleTransaction(state, "Mage", ["Mage"]));
  assert.equal(textOf(kept), textOf(state));
});

test("the plugin colours known and unknown handles", () => {
  const plugin = harnessHandlesPlugin({
    isKnown: (handle) => handle.toLowerCase() === "ryan",
    skipNames: () => ["Mage"],
    onKeyDown: () => false,
    onStateChange: () => {},
  });
  const state = stateOf([["paragraph", ["@Mage @ryan @who"]]], undefined, [
    plugin,
  ]);
  const found = harnessHandlesKey
    .getState(state)
    .find()
    .map((d) => [d.from, d.to, d.type.attrs.class]);
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map(([from, to]) => [from, to]),
    [
      [7, 12],
      [13, 17],
    ],
  );
  assert.match(found[0][2], /amber/);
  assert.match(found[1][2], /muted/);
});
