import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import { LayoutGrid, List } from "lucide-react";

import type { ProjectRepoFile } from "@/features/projects/hooks";
import { REPOSITORY_ENTRY_PAGE_SIZE } from "@/features/projects/lib/projectsViewHelpers";
import type { ProjectRepoThumbnail } from "@/shared/api/projectGit";
import { cn } from "@/shared/lib/cn";
import {
  imagePathsByPage,
  type RepositoryViewMode,
  readRepositoryViewMode,
  splitTileEntries,
  writeRepositoryViewMode,
} from "./repositoryTiles";
import type { RepositoryFileContentSource } from "./useRepositoryFileContent";

type TileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  latestCommit: ProjectRepoFile["latestCommit"];
};

export function useRepositoryViewMode() {
  const [mode, setMode] = React.useState(readRepositoryViewMode);
  const change = React.useCallback((next: RepositoryViewMode) => {
    setMode(next);
    writeRepositoryViewMode(next);
  }, []);
  return [mode, change] as const;
}

export function RepositoryViewModeToggle({
  className,
  mode,
  onChange,
}: {
  className?: string;
  mode: RepositoryViewMode;
  onChange: (mode: RepositoryViewMode) => void;
}) {
  const options = [
    { Icon: List, label: "Details", value: "details" },
    { Icon: LayoutGrid, label: "Tiles", value: "tiles" },
  ] as const;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pair of toggle buttons, not a form fieldset
    <div
      aria-label="File view"
      className={cn(
        "flex shrink-0 items-center rounded-md border border-border/60 p-0.5",
        className,
      )}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      role="group"
    >
      {options.map(({ Icon, label, value }) => (
        <button
          aria-label={label}
          aria-pressed={mode === value}
          className={cn(
            "rounded p-1 text-muted-foreground transition-colors hover:text-foreground",
            mode === value && "bg-muted text-foreground",
          )}
          data-testid={`project-repository-view-${value}`}
          key={value}
          onClick={() => onChange(value)}
          title={label}
          type="button"
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

/** One thumbnail request per listing page; `pending` holds paths still loading. */
function useThumbnails(
  pages: string[][],
  source: RepositoryFileContentSource | undefined,
) {
  const loadThumbnails = source?.loadThumbnails;
  const results = useQueries({
    queries: pages.map((paths) => ({
      enabled: Boolean(loadThumbnails),
      queryKey: [
        "project-repository-thumbnails",
        ...(source?.cacheKey ?? []),
        ...paths,
      ],
      queryFn: () => (loadThumbnails ? loadThumbnails(paths) : []),
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  });
  const byPath = new Map<string, ProjectRepoThumbnail>();
  const pending = new Set<string>();
  results.forEach((result, index) => {
    if (result.isLoading && result.fetchStatus !== "idle") {
      for (const path of pages[index]) pending.add(path);
    }
    for (const thumb of result.data ?? []) byPath.set(thumb.path, thumb);
  });
  return { byPath, pending };
}

function IconTile<T extends TileEntry>({
  entry,
  onOpen,
  renderIcon,
}: {
  entry: T;
  onOpen: (entry: T) => void;
  renderIcon: (entry: T) => React.ReactNode;
}) {
  return (
    <button
      aria-label={`Open ${entry.type} ${entry.name}`}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-left text-xs transition-colors hover:bg-muted/45"
      data-testid="project-repository-icon-tile"
      onClick={() => onOpen(entry)}
      type="button"
    >
      {renderIcon(entry)}
      <span className="min-w-0 truncate font-medium text-foreground">
        {entry.name}
      </span>
    </button>
  );
}

function ImageTile<T extends TileEntry>({
  entry,
  onOpen,
  thumbnail,
}: {
  entry: T;
  onOpen: (entry: T) => void;
  thumbnail?: ProjectRepoThumbnail;
}) {
  const aspectRatio =
    thumbnail && thumbnail.width > 0 && thumbnail.height > 0
      ? `${thumbnail.width} / ${thumbnail.height}`
      : "1 / 1";
  return (
    <button
      aria-label={`Open file ${entry.name}`}
      className="group/tile relative mb-2 block w-full break-inside-avoid overflow-hidden rounded-lg bg-muted/30 text-left"
      data-testid="project-repository-image-tile"
      onClick={() => onOpen(entry)}
      style={{ aspectRatio }}
      type="button"
    >
      {thumbnail ? (
        <img
          alt={entry.name}
          className="h-full w-full object-cover"
          loading="lazy"
          src={thumbnail.dataUrl}
        />
      ) : (
        <span className="block h-full w-full animate-pulse bg-muted/50" />
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2.5 pt-6 pb-2 opacity-0 transition-opacity group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100">
        <span className="block truncate text-xs font-medium text-white">
          {entry.name}
        </span>
        {entry.latestCommit ? (
          <span className="block truncate text-2xs text-white/80">
            {entry.latestCommit.subject}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Folders and non-image files as icon tiles, then the folder's images in a
 * masonry grid that keeps each image's shape. Image sidecars are hidden.
 */
export function RepositoryFileTiles<T extends TileEntry>({
  entries,
  fileContentSource,
  onOpen,
  renderIcon,
}: {
  entries: T[];
  fileContentSource?: RepositoryFileContentSource;
  onOpen: (entry: T) => void;
  renderIcon: (entry: T) => React.ReactNode;
}) {
  const { images, others } = React.useMemo(
    () => splitTileEntries(entries),
    [entries],
  );
  const pages = React.useMemo(
    () => imagePathsByPage(entries, REPOSITORY_ENTRY_PAGE_SIZE),
    [entries],
  );
  const thumbnails = useThumbnails(pages, fileContentSource);
  const hasTile = (entry: T) =>
    thumbnails.pending.has(entry.path) || thumbnails.byPath.has(entry.path);
  const shownImages = images.filter(hasTile);
  const unpreviewable = images.filter((entry) => !hasTile(entry));
  const iconEntries = [...others, ...unpreviewable];

  return (
    <div className="space-y-3 px-4 pt-2 pb-4">
      {iconEntries.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
          {iconEntries.map((entry) => (
            <IconTile
              entry={entry}
              key={`${entry.type}:${entry.path}`}
              onOpen={onOpen}
              renderIcon={renderIcon}
            />
          ))}
        </div>
      ) : null}
      {shownImages.length > 0 ? (
        <div style={{ columnGap: "0.5rem", columnWidth: "13rem" }}>
          {shownImages.map((entry) => (
            <ImageTile
              entry={entry}
              key={entry.path}
              onOpen={onOpen}
              thumbnail={thumbnails.byPath.get(entry.path)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
