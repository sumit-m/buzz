/**
 * LOCAL DIVERGENCE: the Files view's sort (name, last changed, created, size,
 * either way). Folders always come first; among folders, the dates are the
 * newest change and the oldest creation inside them, and size falls back to
 * name. Entries without the value sort last, then by name. Pure — no React.
 */

export type RepositorySortField = "name" | "lastChanged" | "created" | "size";
export type RepositorySortDirection = "asc" | "desc";
export type RepositorySort = {
  field: RepositorySortField;
  direction: RepositorySortDirection;
};

export const DEFAULT_REPOSITORY_SORT: RepositorySort = {
  field: "name",
  direction: "asc",
};

export const REPOSITORY_SORT_FIELDS: {
  field: RepositorySortField;
  label: string;
  /** Labels for ascending, then descending. */
  directions: [string, string];
  /** The direction a newly picked field starts in. */
  initial: RepositorySortDirection;
}[] = [
  { field: "name", label: "Name", directions: ["A–Z", "Z–A"], initial: "asc" },
  {
    field: "lastChanged",
    label: "Last changed",
    directions: ["Oldest first", "Newest first"],
    initial: "desc",
  },
  {
    field: "created",
    label: "Created",
    directions: ["Oldest first", "Newest first"],
    initial: "desc",
  },
  {
    field: "size",
    label: "Size",
    directions: ["Smallest first", "Largest first"],
    initial: "desc",
  },
];

const SORT_KEY = "buzz.projects.repositoryFiles.sort";

export function readRepositorySort(): RepositorySort {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null");
    if (
      REPOSITORY_SORT_FIELDS.some((option) => option.field === saved?.field) &&
      (saved.direction === "asc" || saved.direction === "desc")
    ) {
      return { field: saved.field, direction: saved.direction };
    }
  } catch {
    /* fall back to the default */
  }
  return DEFAULT_REPOSITORY_SORT;
}

export function writeRepositorySort(sort: RepositorySort) {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    /* the choice just isn't remembered */
  }
}

type SortableFile = { path: string; createdAt?: number | null };

type SortableEntry = {
  type: "directory" | "file";
  name: string;
  path: string;
  size: number | null;
  lastChangedAt: number | null;
  file?: SortableFile;
};

/** Each folder entry's oldest created date among the files inside it. */
function folderCreatedAt(
  entries: readonly SortableEntry[],
  files: readonly SortableFile[],
): Map<string, number> {
  const folders = new Set(
    entries
      .filter((entry) => entry.type === "directory")
      .map((entry) => entry.path),
  );
  const oldest = new Map<string, number>();
  if (folders.size === 0) return oldest;
  for (const file of files) {
    if (file.createdAt == null) continue;
    let slash = file.path.indexOf("/");
    while (slash !== -1) {
      const folder = file.path.slice(0, slash);
      if (folders.has(folder)) {
        const known = oldest.get(folder);
        if (known === undefined || file.createdAt < known) {
          oldest.set(folder, file.createdAt);
        }
        break;
      }
      slash = file.path.indexOf("/", slash + 1);
    }
  }
  return oldest;
}

export function sortRepositoryEntries<Entry extends SortableEntry>(
  entries: readonly Entry[],
  files: readonly SortableFile[],
  sort: RepositorySort,
): Entry[] {
  const folderCreated =
    sort.field === "created" ? folderCreatedAt(entries, files) : new Map();
  const value = (entry: Entry): number | null => {
    switch (sort.field) {
      case "lastChanged":
        return entry.lastChangedAt;
      case "created":
        return entry.type === "directory"
          ? (folderCreated.get(entry.path) ?? null)
          : (entry.file?.createdAt ?? null);
      case "size":
        return entry.type === "directory" ? null : entry.size;
      default:
        return null;
    }
  };
  const sign = sort.direction === "asc" ? 1 : -1;
  const byName = (left: Entry, right: Entry) =>
    left.name.localeCompare(right.name);
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    if (sort.field === "name") return sign * byName(left, right);
    const a = value(left);
    const b = value(right);
    if (a !== b) {
      if (a === null) return 1;
      if (b === null) return -1;
      return sign * (a - b);
    }
    return byName(left, right);
  });
}
