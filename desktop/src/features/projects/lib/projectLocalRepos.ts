/**
 * Which directory names under the repos root could hold a repository's
 * checkout.
 *
 * This mirrors `local_repo_candidates`
 * (`desktop/src-tauri/src/commands/project_repo_paths.rs`) and must stay in the
 * same order, because the Rust side clones into the first candidate whose
 * directory is free. When the two disagree the checkout still works — every git
 * command resolves the directory in Rust — but the UI cannot see it: "Clone"
 * never becomes "Open", and the local-only filter hides a repository that is in
 * fact cloned.
 *
 * KNOWN GAP: Rust keeps `<pubkey>--<repo>` as a third candidate for the case
 * where the bare name is already taken by another owner. That form is not
 * generated here, so a collision-named checkout stays invisible to the UI. See
 * "Local-checkout directory name collides between owners" in .scratch/PR-BACKLOG.md.
 */

import type { Project, Repository } from "@/features/projects/hooks";

function localRepoNameCandidate(value: string | null | undefined) {
  const trimmed = value?.trim().replace(/\.git$/i, "") ?? "";
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  return trimmed;
}

function cloneUrlRepoName(cloneUrl: string | undefined) {
  if (!cloneUrl) return null;
  try {
    const parsed = new URL(cloneUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    return localRepoNameCandidate(lastSegment);
  } catch {
    return null;
  }
}

export function localRepoCandidates(repository: Repository) {
  return [
    cloneUrlRepoName(repository.cloneUrls[0]),
    localRepoNameCandidate(repository.dtag),
  ].filter((candidate, index, candidates): candidate is string =>
    Boolean(candidate && candidates.indexOf(candidate) === index),
  );
}

export function hasLocalCheckout(
  project: Project,
  localRepoNames: Set<string>,
) {
  return project.repositories.some((repository) =>
    hasLocalRepositoryCheckout(repository, localRepoNames),
  );
}

export function hasLocalRepositoryCheckout(
  repository: Repository,
  localRepoNames: Set<string>,
) {
  return localRepoCandidates(repository).some((candidate) =>
    localRepoNames.has(candidate),
  );
}
