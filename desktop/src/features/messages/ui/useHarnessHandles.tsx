import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import type { ComposerSpec } from "@/features/messages/lib/composerHarnessState";
import {
  type HandleQuery,
  handleQueryAt,
  harnessHandlesKey,
  harnessHandlesPlugin,
  rehighlightTransaction,
  removeHandleTransaction,
} from "@/features/messages/lib/harnessHandlesPlugin";
import {
  type AttachedImage,
  imageRefContent,
} from "@/features/messages/lib/harnessImageRefNode";
import {
  type AssetEntry,
  assetControls,
  assetIndex,
  findHandles,
  IMAGES_CONTROL,
  imageEntries,
  matchAssets,
  uniqueHandles,
  withEntries,
} from "@/features/messages/lib/promptHandles";
import { refreshHarnessControl } from "@/shared/api/harnessComposer";
import {
  HANDLE_AUTOCOMPLETE_WIDTH_PX,
  HandleAutocomplete,
  HandleTile,
} from "./HarnessAssets";

function sameQuery(a: HandleQuery | null, b: HandleQuery | null) {
  return a?.query === b?.query && a?.from === b?.from && a?.to === b?.to;
}

/**
 * LOCAL DIVERGENCE: `@handle` words in a harness panel's prompt — colouring,
 * the `@` autocomplete, the chips above the prompt, and menu picks. Only for
 * a panel with `assets` menus, or one taking image references. The prompt
 * text stays the source of truth: a pick inserts `@handle`, a chip's ✕
 * deletes it. An attached image's entry inserts its inline reference.
 */
export function useHarnessHandles({
  editor,
  harnessId,
  images,
  mentionNames,
  spec,
  text,
}: {
  editor: Editor | null;
  harnessId: string | null;
  /** Attached images the prompt may name, in order (none when off). */
  images: readonly AttachedImage[];
  /** Buzz mention names in the draft, which are never handles. */
  mentionNames: readonly string[];
  spec: ComposerSpec | null;
  text: string;
}) {
  const queryClient = useQueryClient();
  const index = React.useMemo(
    () =>
      withEntries(
        assetIndex(spec ? [spec] : []),
        imageEntries(
          images.map((image) => image.thumb),
          "attached",
        ),
      ),
    [images, spec],
  );
  const menus = spec ? assetControls(spec) : [];
  const enabled = Boolean(editor && (menus.length > 0 || images.length > 0));
  const indexRef = React.useRef(index);
  indexRef.current = index;
  const namesRef = React.useRef(mentionNames);
  namesRef.current = mentionNames;
  const keyDownRef = React.useRef<(event: KeyboardEvent) => boolean>(
    () => false,
  );
  const [query, setQuery] = React.useState<HandleQuery | null>(null);
  const [dismissedFrom, setDismissedFrom] = React.useState<number | null>(null);
  const [highlighted, setHighlighted] = React.useState(0);
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled || !editor || editor.isDestroyed) return undefined;
    editor.registerPlugin(
      harnessHandlesPlugin({
        isKnown: (handle) => indexRef.current.has(handle.toLowerCase()),
        skipNames: () => namesRef.current,
        onKeyDown: (event) => keyDownRef.current(event),
        onStateChange: (state) => {
          const next = handleQueryAt(state);
          setQuery((previous) => (sameQuery(previous, next) ? previous : next));
        },
      }),
      (plugin, plugins) => [plugin, ...plugins],
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(harnessHandlesKey);
      setQuery(null);
    };
  }, [editor, enabled]);

  const namesKey = mentionNames.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-colour when the known handles or mention names change
  React.useEffect(() => {
    if (!enabled || !editor || editor.isDestroyed) return;
    editor.view.dispatch(rehighlightTransaction(editor.state));
  }, [editor, enabled, index, namesKey]);

  const refreshControl = React.useCallback(
    async (controlId: string) => {
      if (!harnessId) return;
      setRefreshingId(controlId);
      try {
        queryClient.setQueryData(
          ["harness-composers"],
          await refreshHarnessControl(harnessId, controlId),
        );
      } catch (error) {
        console.warn("harness control refresh failed", error);
      } finally {
        setRefreshingId((current) => (current === controlId ? null : current));
      }
    },
    [harnessId, queryClient],
  );

  const open = enabled && query !== null && query.from !== dismissedFrom;
  const matches = open && query ? matchAssets(query.query, index) : [];
  // The menu opens above the `@`'s line, starting at the `@`, kept inside
  // the prompt's (scrolling) box.
  const menuAt = { left: 0, top: 0 };
  if (open && query && editor && !editor.isDestroyed) {
    const dom = editor.view.dom;
    const box = (
      dom.closest('[data-testid="message-input-scroll"]') ?? dom
    ).getBoundingClientRect();
    const caret = editor.view.coordsAtPos(query.from);
    const room = box.width - HANDLE_AUTOCOMPLETE_WIDTH_PX;
    menuAt.left = Math.max(0, Math.min(caret.left - box.left, room));
    menuAt.top = Math.max(0, caret.top - box.top);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at its first match
  React.useEffect(() => {
    setHighlighted(0);
    if (query === null) setDismissedFrom(null);
  }, [query?.query, query?.from]);

  // The menus re-read assets when opened; the autocomplete does once per mention.
  const refreshedRef = React.useRef(false);
  const firstRefreshable = menus.find((menu) => menu.refresh?.length)?.id;
  React.useEffect(() => {
    if (!enabled) {
      refreshedRef.current = false;
      return;
    }
    if (open && firstRefreshable && !refreshedRef.current) {
      refreshedRef.current = true;
      void refreshControl(firstRefreshable);
    }
  }, [enabled, firstRefreshable, open, refreshControl]);

  const select = (entry: AssetEntry) => {
    if (!editor || !query) return;
    const range = { from: query.from, to: query.to };
    const at =
      entry.control === IMAGES_CONTROL
        ? images.findIndex((_, i) => `image${i + 1}` === entry.option.value)
        : -1;
    editor
      .chain()
      .focus()
      .insertContentAt(
        range,
        at >= 0
          ? imageRefContent(images, at)
          : { type: "text", text: `@${entry.option.value} ` },
      )
      .run();
  };

  keyDownRef.current = (event) => {
    if (!open || !query) return false;
    if (event.key === "Escape") {
      setDismissedFrom(query.from);
      return true;
    }
    if (matches.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((i) => (i + step + matches.length) % matches.length);
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      select(matches[Math.min(highlighted, matches.length - 1)]);
      return true;
    }
    return false;
  };

  const insertHandle = (handle: string) => {
    if (!editor || editor.isDestroyed) return;
    const { $from } = editor.state.selection;
    const before = $from.parent.textBetween(
      Math.max(0, $from.parentOffset - 1),
      $from.parentOffset,
      undefined,
      "￼",
    );
    const lead = before && !/\s/.test(before) ? " " : "";
    editor
      .chain()
      .focus()
      .insertContent({ type: "text", text: `${lead}@${handle} ` })
      .run();
  };

  const removeHandle = (handle: string) => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(
      removeHandleTransaction(editor.state, handle, namesRef.current),
    );
    editor.commands.focus();
  };

  // Image references show inline, so they get no chip above the prompt.
  const handles = enabled
    ? uniqueHandles(findHandles(text, mentionNames)).filter(
        (handle) => index.get(handle.toLowerCase())?.control !== IMAGES_CONTROL,
      )
    : [];

  return {
    enabled,
    insertHandle,
    refreshControl,
    refreshingId,
    /** The `@` autocomplete, above the prompt. */
    autocomplete:
      enabled && open ? (
        <HandleAutocomplete
          highlighted={highlighted}
          at={menuAt}
          matches={matches}
          onHighlight={setHighlighted}
          onSelect={select}
        />
      ) : null,
    /** A tile per prompt handle, for the attachment row. */
    tiles: handles.map((handle) => (
      <HandleTile
        entry={index.get(handle.toLowerCase())}
        handle={handle}
        key={handle.toLowerCase()}
        onRemove={() => removeHandle(handle)}
      />
    )),
  };
}
