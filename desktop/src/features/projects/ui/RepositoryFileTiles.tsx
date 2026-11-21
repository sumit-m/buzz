import * as React from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, List, Play } from "lucide-react";

import type { ProjectRepoFile } from "@/features/projects/hooks";
import type { ProjectRepoThumbnail } from "@/shared/api/projectGit";
import { cn } from "@/shared/lib/cn";
import {
  type RepositoryViewMode,
  readRepositoryViewMode,
  splitTileEntries,
  writeRepositoryViewMode,
} from "./repositoryTiles";
import { changedImages, thumbnailQuery } from "./repositoryThumbnails";
import { videoMimeForPath } from "./repositoryVideo";
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

/** Cached per image; `pending` holds paths still loading. */
function useThumbnails<T extends TileEntry>(
  images: T[],
  source: RepositoryFileContentSource | undefined,
) {
  const results = useQueries({
    queries: images.map((entry) => thumbnailQuery(source, entry)),
  });
  const byPath = new Map<string, ProjectRepoThumbnail>();
  const pending = new Set<string>();
  results.forEach((result, index) => {
    const path = images[index].path;
    if (result.isLoading && result.fetchStatus !== "idle") pending.add(path);
    if (result.data) byPath.set(path, result.data);
  });
  return { byPath, pending };
}

/**
 * Thumbnails for the images a refresh added or changed, made in the
 * background so they are ready when the user browses back to the tiles.
 */
export function usePrefetchChangedThumbnails(
  files: ProjectRepoFile[],
  source: RepositoryFileContentSource | undefined,
) {
  const queryClient = useQueryClient();
  const previous = React.useRef<{
    files: ProjectRepoFile[];
    sourceKey: string;
  } | null>(null);
  React.useEffect(() => {
    if (!source?.loadThumbnails || files.length === 0) return;
    const sourceKey = JSON.stringify(source.cacheKey);
    const before = previous.current;
    previous.current = { files, sourceKey };
    if (!before || before.sourceKey !== sourceKey) return;
    for (const file of changedImages(before.files, files)) {
      void queryClient.prefetchQuery(thumbnailQuery(source, file));
    }
  }, [files, queryClient, source]);
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
      {videoMimeForPath(entry.path) ? (
        <span
          className="pointer-events-none absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
          data-testid="project-repository-video-badge"
        >
          <Play className="ml-px h-3 w-3 fill-current" />
        </span>
      ) : null}
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
 * Folders and other files as icon tiles, then the folder's images and videos
 * in a masonry grid that keeps each one's shape (a video marked with a play
 * badge). Their sidecars are hidden.
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
  const thumbnails = useThumbnails(images, fileContentSource);
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
