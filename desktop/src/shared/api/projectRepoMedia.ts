/**
 * LOCAL DIVERGENCE: repository files as `buzz-repo` URLs, which the desktop
 * serves by byte range, so a `<video>` reads only what it plays (or, for a
 * tile, the header and first frame). A session token names one checkout.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { invokeTauri } from "@/shared/api/tauri";

export async function openProjectRepoMedia(input: {
  cloneUrl: string;
  defaultBranch?: string | null;
  targetRef?: string | null;
  targetCommit?: string | null;
}): Promise<string> {
  return invokeTauri<string>("open_project_repo_media", {
    cloneUrl: input.cloneUrl,
    defaultBranch: input.defaultBranch ?? null,
    targetRef: input.targetRef ?? null,
    targetCommit: input.targetCommit ?? null,
  });
}

export async function openProjectLocalRepoMedia(input: {
  reposDir?: string | null;
  projectDtag: string;
  cloneUrl?: string | null;
}): Promise<string | null> {
  return invokeTauri<string | null>("open_project_local_repo_media", {
    reposDir: input.reposDir ?? null,
    projectDtag: input.projectDtag,
    cloneUrl: input.cloneUrl ?? null,
  });
}

/** The URL serving `path` from the checkout a session `token` names. */
export function repoMediaUrl(token: string, path: string): string {
  return convertFileSrc(`${token}/${path}`, "buzz-repo");
}
