/**
 * LOCAL DIVERGENCE: folder suggestions for the message-box repo:folder
 * picker. Pure.
 */

export type FolderSuggestion =
  | { kind: "root"; path: "" }
  | { kind: "folder"; path: string }
  | { kind: "create"; path: string };

const INITIAL_DEPTH = 2;
const MAX_ROWS = 50;

/** `art\\foxes`, `/art/foxes`, `./art/foxes/` → `art/foxes/`; root → "". */
export function normalizeFolder(input: string): string {
  const trimmed = input
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/|\/)+/, "")
    .replace(/\/{2,}/g, "/");
  if (trimmed === "" || trimmed === ".") return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** Every parent folder of every file path, for reuse of a loaded file list. */
export function foldersFromFilePaths(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end += 1) {
      folders.add(parts.slice(0, end).join("/"));
    }
  }
  return [...folders].sort();
}

function depth(folder: string): number {
  return folder.replace(/\/$/, "").split("/").length;
}

export function folderSuggestions(
  folders: readonly string[],
  query: string,
  recent: readonly string[] = [],
): FolderSuggestion[] {
  const all = [...new Set(folders.map(normalizeFolder).filter(Boolean))];
  const typed = normalizeFolder(query);
  const needle = query.trim().replace(/\\/g, "/").toLowerCase();
  const recentRank = (folder: string) => {
    const index = recent.indexOf(folder);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  const matches = all
    .filter((folder) =>
      needle
        ? folder.toLowerCase().includes(needle)
        : depth(folder) <= INITIAL_DEPTH,
    )
    .sort(
      (left, right) =>
        recentRank(left) - recentRank(right) || left.localeCompare(right),
    );

  const rows: FolderSuggestion[] = [];
  if (!needle) rows.push({ kind: "root", path: "" });
  for (const folder of matches.slice(0, MAX_ROWS)) {
    rows.push({ kind: "folder", path: folder });
  }
  if (typed && !all.includes(typed)) {
    rows.push({ kind: "create", path: typed });
  }
  return rows;
}
