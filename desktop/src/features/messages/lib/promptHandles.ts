/**
 * LOCAL DIVERGENCE: `@handle` words in a harness prompt (mage characters and
 * references). Pure — no React, no editor.
 */

import type {
  ComposerControl,
  ComposerOption,
  ComposerSpec,
} from "./composerHarnessState";

export type HandleSpan = { start: number; end: number; handle: string };

export type AssetEntry = { control: ComposerControl; option: ComposerOption };

/** Lowercased handle → its asset. */
export type AssetIndex = ReadonlyMap<string, AssetEntry>;

export const KNOWN_HANDLE_CLASS =
  "font-semibold text-amber-600 dark:text-amber-400";
export const UNKNOWN_HANDLE_CLASS = "font-semibold text-muted-foreground";

const HANDLE_CHAR = /[\p{L}\p{N}_.-]/u;
/** `￼` stands for a line break or other inline node in editor text. */
const BEFORE_HANDLE = /[\s([{"'“‘￼]/u;
const TRAILING_PUNCTUATION = /[.-]/;
const QUERY_AT_END = /(?:^|[\s([{"'“‘￼])@([\p{L}\p{N}_.-]{0,64})$/u;

/** The pseudo-menu of a prompt's image references (`@image1`, `@image2`…). */
export const IMAGES_CONTROL: ComposerControl = {
  id: "@images",
  kind: "images",
  label: "Image",
  options: [],
};

/** Entries for `@image1…`, one per image in order, with its thumbnail. */
export function imageEntries(
  thumbs: readonly string[],
  hint: string,
): AssetEntry[] {
  return thumbs.map((thumb, at) => ({
    control: IMAGES_CONTROL,
    option: {
      value: `image${at + 1}`,
      label: `Image ${at + 1}`,
      image: thumb,
      hint,
    },
  }));
}

/** `index` plus `entries`, which win on a clash. */
export function withEntries(
  index: AssetIndex,
  entries: readonly AssetEntry[],
): AssetIndex {
  if (entries.length === 0) return index;
  const all = new Map<string, AssetEntry>();
  for (const entry of entries) all.set(entry.option.value.toLowerCase(), entry);
  for (const [key, entry] of index) if (!all.has(key)) all.set(key, entry);
  return all;
}

export function assetControls(spec: ComposerSpec): ComposerControl[] {
  return spec.controls.filter((control) => control.kind === "assets");
}

export function assetIndex(specs: readonly ComposerSpec[]): AssetIndex {
  const index = new Map<string, AssetEntry>();
  for (const spec of specs) {
    for (const control of assetControls(spec)) {
      for (const option of control.options) {
        const key = option.value.toLowerCase();
        if (!index.has(key)) index.set(key, { control, option });
      }
    }
  }
  return index;
}

/**
 * Every `@handle` in `text`. An `@` counts only at the start or after a space
 * or opening bracket or quote (not in `a@b.com`), and a Buzz mention whose
 * name is in `skipNames` is passed over, since it addresses an agent.
 */
export function findHandles(
  text: string,
  skipNames: readonly string[] = [],
): HandleSpan[] {
  const skip = skipNames
    .map((name) => name.toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const spans: HandleSpan[] = [];
  let at = text.indexOf("@");
  while (at !== -1) {
    let next = at + 1;
    if (at === 0 || BEFORE_HANDLE.test(text[at - 1])) {
      const rest = text.slice(at + 1);
      const lower = rest.toLowerCase();
      const mention = skip.find(
        (name) =>
          lower.startsWith(name) && !HANDLE_CHAR.test(rest[name.length] ?? ""),
      );
      if (mention) {
        next = at + 1 + mention.length;
      } else {
        let end = at + 1;
        while (end < text.length && HANDLE_CHAR.test(text[end])) end += 1;
        while (end > at + 1 && TRAILING_PUNCTUATION.test(text[end - 1])) {
          end -= 1;
        }
        if (end > at + 1) {
          spans.push({ start: at, end, handle: text.slice(at + 1, end) });
          next = end;
        }
      }
    }
    at = text.indexOf("@", next);
  }
  return spans;
}

/** Each handle once, case-insensitively, in order of first use. */
export function uniqueHandles(spans: readonly HandleSpan[]): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const { handle } of spans) {
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
  }
  return handles;
}

/** The handle being typed at the end of `textBefore` (the caret), if any. */
export function handleQueryAtEnd(textBefore: string): string | null {
  return QUERY_AT_END.exec(textBefore)?.[1] ?? null;
}

/** Assets whose handle or name starts with `query`, then those containing it. */
export function matchAssets(
  query: string,
  index: AssetIndex,
  limit = 8,
): AssetEntry[] {
  const needle = query.toLowerCase();
  const starts: AssetEntry[] = [];
  const contains: AssetEntry[] = [];
  for (const entry of index.values()) {
    const handle = entry.option.value.toLowerCase();
    const name = entry.option.label.toLowerCase();
    if (handle.startsWith(needle) || name.startsWith(needle)) {
      starts.push(entry);
    } else if (handle.includes(needle) || name.includes(needle)) {
      contains.push(entry);
    }
  }
  return [...starts, ...contains].slice(0, limit);
}
