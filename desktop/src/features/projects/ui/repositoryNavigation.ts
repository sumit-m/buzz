import type { ProjectRepoFile } from "@/shared/api/projectGitTypes";

/**
 * LOCAL DIVERGENCE: keeps the Files view where the user left it when the
 * repository's file list refreshes (a push from an agent, a regenerate, a
 * teammate). Upstream reset to the initial path on every change, which closed
 * an open image and jumped to the root or the deep-linked folder.
 */
export function parentPath(path: string) {
  return path.split("/").slice(0, -1).join("/");
}

export function isFolderPath(files: ProjectRepoFile[], path: string) {
  if (!path) return true;
  const prefix = `${path}/`;
  return files.some((file) => file.path.startsWith(prefix));
}

function sameFile(a: ProjectRepoFile, b: ProjectRepoFile) {
  return (
    a.path === b.path &&
    a.kind === b.kind &&
    a.size === b.size &&
    a.lastChangedAt === b.lastChangedAt &&
    a.createdAt === b.createdAt &&
    a.previewContent === b.previewContent &&
    a.latestCommit?.hash === b.latestCommit?.hash
  );
}

/** The open file as the new list has it, or null once it is gone. */
export function freshFile(
  files: ProjectRepoFile[],
  current: ProjectRepoFile | null,
) {
  if (!current) return null;
  const fresh = files.find((file) => file.path === current.path);
  if (!fresh) return null;
  return sameFile(fresh, current) ? current : fresh;
}

/** The folder itself while it still has files, else its nearest ancestor that does. */
export function existingFolder(files: ProjectRepoFile[], path: string) {
  let folder = path;
  while (folder && !isFolderPath(files, folder)) folder = parentPath(folder);
  return folder;
}
