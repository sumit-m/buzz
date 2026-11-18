/**
 * LOCAL DIVERGENCE: the editor side of a harness panel's `@handle` words —
 * known handles in bold yellow, unknown ones in bold grey, and the keys of
 * the handle autocomplete. Added to the editor only while the panel shows.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  findHandles,
  handleQueryAtEnd,
  KNOWN_HANDLE_CLASS,
  UNKNOWN_HANDLE_CLASS,
} from "./promptHandles";

export const harnessHandlesKey = new PluginKey<DecorationSet>("harnessHandles");

export type HarnessHandlesConfig = {
  isKnown: (handle: string) => boolean;
  skipNames: () => readonly string[];
  /** True when the autocomplete took the key. */
  onKeyDown: (event: KeyboardEvent) => boolean;
  onStateChange: (state: EditorState) => void;
};

/** One character per leaf node, so offsets line up with document positions. */
const LEAF_TEXT = "￼";

function eachTextblock(
  doc: ProseMirrorNode,
  visit: (text: string, start: number) => void,
) {
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (!node.type.spec.code) {
      visit(
        node.textBetween(0, node.content.size, undefined, LEAF_TEXT),
        pos + 1,
      );
    }
    return false;
  });
}

function decorate(doc: ProseMirrorNode, config: HarnessHandlesConfig) {
  const decorations: Decoration[] = [];
  const skip = config.skipNames();
  eachTextblock(doc, (text, start) => {
    for (const span of findHandles(text, skip)) {
      decorations.push(
        Decoration.inline(start + span.start, start + span.end, {
          class: config.isKnown(span.handle)
            ? KNOWN_HANDLE_CLASS
            : UNKNOWN_HANDLE_CLASS,
          spellcheck: "false",
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export function harnessHandlesPlugin(config: HarnessHandlesConfig) {
  return new Plugin<DecorationSet>({
    key: harnessHandlesKey,
    state: {
      init: (_, state) => decorate(state.doc, config),
      apply: (tr, previous, _, next) =>
        tr.docChanged || tr.getMeta(harnessHandlesKey)
          ? decorate(next.doc, config)
          : previous.map(tr.mapping, tr.doc),
    },
    props: {
      decorations: (state) => harnessHandlesKey.getState(state),
      handleKeyDown: (_, event) => config.onKeyDown(event),
    },
    view: (view) => {
      config.onStateChange(view.state);
      return { update: (updated) => config.onStateChange(updated.state) };
    },
  });
}

/** Re-colours handles after the known set changed. */
export function rehighlightTransaction(state: EditorState): Transaction {
  return state.tr.setMeta(harnessHandlesKey, true);
}

export type HandleQuery = { query: string; from: number; to: number };

/** The `@handle` being typed at the caret, with the range it replaces. */
export function handleQueryAt(state: EditorState): HandleQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.spec.code) return null;
  const before = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 66),
    $from.parentOffset,
    undefined,
    LEAF_TEXT,
  );
  const query = handleQueryAtEnd(before);
  if (query === null) return null;
  return { query, from: $from.pos - query.length - 1, to: $from.pos };
}

/** Deletes every use of `handle` (with one following space). */
export function removeHandleTransaction(
  state: EditorState,
  handle: string,
  skipNames: readonly string[],
): Transaction {
  const ranges: [number, number][] = [];
  const wanted = handle.toLowerCase();
  eachTextblock(state.doc, (text, start) => {
    for (const span of findHandles(text, skipNames)) {
      if (span.handle.toLowerCase() !== wanted) continue;
      const end = text[span.end] === " " ? span.end + 1 : span.end;
      ranges.push([start + span.start, start + end]);
    }
  });
  const tr = state.tr;
  for (const [from, to] of ranges.reverse()) tr.delete(from, to);
  return tr;
}
