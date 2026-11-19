import type { HarnessComposer } from "@/features/messages/lib/composerHarnessState";
import { invokeTauri } from "@/shared/api/tauri";

/** Message-box controls declared by custom harnesses (LOCAL DIVERGENCE). */
export function listHarnessComposers(): Promise<HarnessComposer[]> {
  return invokeTauri<HarnessComposer[]>("list_harness_composers");
}

/** Runs a control's refresh (its menu opened); returns every panel. */
export function refreshHarnessControl(
  harnessId: string,
  controlId: string,
): Promise<HarnessComposer[]> {
  return invokeTauri<HarnessComposer[]>("refresh_harness_control", {
    harnessId,
    controlId,
  });
}

/** Paths at a branch's tip whose file name is one of `names`. */
export function findProjectRepoFiles(input: {
  cloneUrl: string;
  branch?: string | null;
  names: string[];
}): Promise<string[]> {
  return invokeTauri<string[]>("find_project_repo_files", {
    cloneUrl: input.cloneUrl,
    branch: input.branch ?? null,
    names: input.names,
  });
}

export type RepoFileAdd =
  | { path: string; url: string }
  | { path: string; contentBase64: string };

/** One commit of renames, additions and deletions, made and pushed as one of the viewer's managed agents. */
export function commitProjectRepoFiles(input: {
  agentPubkey: string;
  cloneUrl: string;
  branch?: string | null;
  renames?: { from: string; to: string }[];
  adds?: RepoFileAdd[];
  deletes?: string[];
  message: string;
}): Promise<string> {
  return invokeTauri<string>("commit_project_repo_files", {
    agentPubkey: input.agentPubkey,
    cloneUrl: input.cloneUrl,
    branch: input.branch ?? null,
    renames: input.renames ?? [],
    adds: input.adds ?? [],
    deletes: input.deletes ?? [],
    message: input.message,
  });
}

/** Folder paths at a branch's tip, read from a blobless shallow clone. */
export function getProjectRepoFolders(input: {
  cloneUrl: string;
  branch?: string | null;
}): Promise<string[]> {
  return invokeTauri<string[]>("get_project_repo_folders", {
    cloneUrl: input.cloneUrl,
    branch: input.branch ?? null,
  });
}
