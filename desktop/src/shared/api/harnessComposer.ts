import type { HarnessComposer } from "@/features/messages/lib/composerHarnessState";
import { invokeTauri } from "@/shared/api/tauri";

/** Message-box controls declared by custom harnesses (LOCAL DIVERGENCE). */
export function listHarnessComposers(): Promise<HarnessComposer[]> {
  return invokeTauri<HarnessComposer[]>("list_harness_composers");
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
