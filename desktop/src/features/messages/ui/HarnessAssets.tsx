/**
 * LOCAL DIVERGENCE: how a harness's assets (mage characters and references)
 * look wherever they show: the panel's menus, the `@` autocomplete, the chips
 * above the prompt and the image info sidebar.
 */

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import * as React from "react";

import type { ComposerOption } from "@/features/messages/lib/composerHarnessState";
import {
  type AssetEntry,
  type AssetIndex,
  assetIndex,
  findHandles,
  IMAGES_CONTROL,
  KNOWN_HANDLE_CLASS,
  UNKNOWN_HANDLE_CLASS,
  uniqueHandles,
} from "@/features/messages/lib/promptHandles";
import { listHarnessComposers } from "@/shared/api/harnessComposer";
import { cn } from "@/shared/lib/cn";
import {
  POPOVER_SHADOW_STYLE,
  POPOVER_SURFACE_CLASS,
} from "@/shared/ui/popoverSurface";
import { COMPOSER_MEDIA_REMOVE_CLASS } from "./ComposerAttachments";

/** Every asset the installed harnesses list, by lowercased handle. */
export function useHarnessAssetIndex(): AssetIndex {
  const composers = useQuery({
    queryKey: ["harness-composers"],
    queryFn: listHarnessComposers,
    staleTime: 60_000,
  });
  return React.useMemo(
    () => assetIndex((composers.data ?? []).map((entry) => entry.composer)),
    [composers.data],
  );
}

/** References carry a variant (hint) and show square; characters round. */
export function AssetThumb({
  className,
  option,
}: {
  className?: string;
  option: ComposerOption;
}) {
  const [failed, setFailed] = React.useState(false);
  const shape = option.hint ? "rounded-md" : "rounded-full";
  if (!option.image || failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center bg-muted text-xs font-medium uppercase text-muted-foreground",
          shape,
          className,
        )}
      >
        {option.label.slice(0, 2)}
      </span>
    );
  }
  return (
    <img
      alt=""
      className={cn("shrink-0 object-cover", shape, className)}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={option.image}
    />
  );
}

export function assetSubtitle(option: ComposerOption) {
  return option.hint ? `@${option.value} · ${option.hint}` : `@${option.value}`;
}

export function AssetRow({
  large = false,
  option,
}: {
  large?: boolean;
  option: ComposerOption;
}) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <AssetThumb className={large ? "h-11 w-11" : "h-8 w-8"} option={option} />
      <span className="flex min-w-0 flex-col text-left">
        <span
          className={cn(
            "truncate font-semibold text-foreground",
            large ? "text-base" : "text-sm",
          )}
        >
          {option.label}
        </span>
        <span className="truncate text-sm text-muted-foreground">
          {assetSubtitle(option)}
        </span>
      </span>
    </span>
  );
}

/**
 * A prompt `@handle` as a tile in the composer's attachment row, the size of
 * an attachment thumbnail: the asset's image, or a dashed "Not found".
 */
export function HandleTile({
  entry,
  handle,
  onRemove,
}: {
  entry: AssetEntry | undefined;
  handle: string;
  onRemove: () => void;
}) {
  const title = entry
    ? `${assetSubtitle(entry.option)} · ${entry.option.label}`
    : `@${handle} · not found`;
  return (
    <div
      className="group relative h-[64px] w-[64px] shrink-0"
      data-testid={`composer-handle-chip-${handle}`}
      title={title}
    >
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-2xl border",
          entry
            ? "border-border/70"
            : "border-dashed border-border bg-muted/40 px-1 text-center",
        )}
      >
        {entry ? (
          <AssetThumb
            className="h-full w-full rounded-none"
            option={entry.option}
          />
        ) : (
          <>
            <span className="max-w-full truncate text-2xs font-medium text-muted-foreground">
              @{handle}
            </span>
            <span className="text-3xs text-muted-foreground/80">Not found</span>
          </>
        )}
      </div>
      {entry ? (
        <span className="absolute inset-x-0 bottom-0 truncate rounded-b-2xl bg-background/80 px-1 text-center text-3xs text-foreground">
          @{handle}
        </span>
      ) : null}
      <button
        aria-label={`Remove @${handle}`}
        className={COMPOSER_MEDIA_REMOVE_CLASS}
        onClick={onRemove}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

/** The menu's width (`w-72`), for keeping it inside the composer. */
export const HANDLE_AUTOCOMPLETE_WIDTH_PX = 288;

/**
 * The `@` autocomplete, opening above `at` (px from the prompt box's top-left:
 * the `@`'s line and position, clamped to fit).
 */
export function HandleAutocomplete({
  at,
  highlighted,
  matches,
  onHighlight,
  onSelect,
}: {
  at: { left: number; top: number };
  highlighted: number;
  matches: AssetEntry[];
  onHighlight: (index: number) => void;
  onSelect: (entry: AssetEntry) => void;
}) {
  return (
    <div
      className="absolute z-50 -translate-y-full pb-1"
      data-testid="composer-handle-autocomplete"
      style={{ left: at.left, top: at.top }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only guard keeps the editor focused while a row is pressed. */}
      <div
        className={cn(
          "max-h-72 w-72 overflow-y-auto rounded-xl p-1",
          POPOVER_SURFACE_CLASS,
        )}
        onMouseDown={(event) => event.preventDefault()}
        style={POPOVER_SHADOW_STYLE}
      >
        {matches.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No results found
          </p>
        ) : (
          matches.map((entry, index) => (
            <button
              className={cn(
                "flex w-full rounded-lg px-2 py-1.5",
                index === highlighted ? "bg-accent" : "hover:bg-accent/50",
              )}
              key={`${entry.control.id}:${entry.option.value}`}
              onClick={() => onSelect(entry)}
              onMouseEnter={() => onHighlight(index)}
              type="button"
            >
              <AssetRow option={entry.option} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** `text` with its `@handles` coloured known (yellow) or unknown (grey). */
export function HighlightedHandles({
  index,
  text,
}: {
  index: AssetIndex;
  text: string;
}) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const span of findHandles(text)) {
    parts.push(text.slice(at, span.start));
    parts.push(
      <span
        className={
          index.has(span.handle.toLowerCase())
            ? KNOWN_HANDLE_CLASS
            : UNKNOWN_HANDLE_CLASS
        }
        key={span.start}
      >
        {text.slice(span.start, span.end)}
      </span>,
    );
    at = span.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * The assets an image's prompt names, grouped by menu (Character, Reference),
 * then handles no installed harness lists. Image references (`@image1`) are
 * left out: the sidebar shows those sources itself.
 */
export function PromptAssets({
  index,
  prompt,
}: {
  index: AssetIndex;
  prompt: string;
}) {
  const groups = new Map<string, { label: string; entries: AssetEntry[] }>();
  const missing: string[] = [];
  for (const handle of uniqueHandles(findHandles(prompt))) {
    const entry = index.get(handle.toLowerCase());
    if (!entry) {
      missing.push(handle);
      continue;
    }
    if (entry.control === IMAGES_CONTROL) continue;
    const group = groups.get(entry.control.id) ?? {
      label: entry.control.label,
      entries: [],
    };
    group.entries.push(entry);
    groups.set(entry.control.id, group);
  }
  if (groups.size === 0 && missing.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="image-info-assets">
      {[...groups.entries()].map(([id, group]) => (
        <div className="space-y-2" key={id}>
          <p className="text-xs text-muted-foreground">{group.label}</p>
          {group.entries.map((entry) => (
            <AssetRow key={entry.option.value} option={entry.option} />
          ))}
        </div>
      ))}
      {missing.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Not found</p>
          <p className="flex flex-wrap gap-x-2 text-sm">
            {missing.map((handle) => (
              <span className={UNKNOWN_HANDLE_CLASS} key={handle}>
                @{handle}
              </span>
            ))}
          </p>
        </div>
      ) : null}
    </div>
  );
}
