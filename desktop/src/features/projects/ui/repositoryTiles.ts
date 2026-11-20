import { imageMimeForPath } from "./useRepositoryImagePreview";

export type RepositoryViewMode = "details" | "tiles";

const VIEW_MODE_KEY = "buzz.projects.repositoryFiles.viewMode";

export function readRepositoryViewMode(): RepositoryViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "tiles"
      ? "tiles"
      : "details";
  } catch {
    return "details";
  }
}

export function writeRepositoryViewMode(mode: RepositoryViewMode) {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    /* the choice just isn't remembered */
  }
}

type TileEntryShape = { name: string; type: "directory" | "file" };

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Images for the masonry grid and everything else for icon tiles, minus each
 * image's `.json` sidecar (same name, `.json` extension, same folder).
 */
export function splitTileEntries<T extends TileEntryShape>(entries: T[]) {
  const isImage = (entry: T) =>
    entry.type === "file" && imageMimeForPath(entry.name) !== null;
  const imageStems = new Set(
    entries.filter(isImage).map((entry) => stem(entry.name)),
  );
  const isSidecar = (entry: T) =>
    entry.type === "file" &&
    entry.name.toLowerCase().endsWith(".json") &&
    imageStems.has(stem(entry.name));
  return {
    images: entries.filter(isImage),
    others: entries.filter((entry) => !isImage(entry) && !isSidecar(entry)),
  };
}
