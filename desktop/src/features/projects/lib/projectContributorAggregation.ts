import type { ProjectRepoContributor } from "@/shared/api/types";
import { contributorKey } from "./projectContributorMatching";

/**
 * LOCAL DIVERGENCE. Fold several repositories' git contributor lists into one.
 *
 * A project's People tab reads one repository's snapshot upstream, so a person
 * who only ever committed to the project's second repository is missing from it
 * with nothing on screen saying so. Commits already fan out over every
 * repository; this lets contributors do the same.
 *
 * Identity is `contributorKey` — email, falling back to name — the same key the
 * commit-to-pubkey matcher uses, so a contributor merged here still resolves to
 * the same Nostr pubkey. Commit counts sum and `lastCommitAt` takes the latest,
 * whose spelling of the name wins: a person who changed `user.name` between
 * repositories is shown as they most recently signed.
 *
 * A single list is returned untouched, so single-repository projects keep the
 * backend's ordering exactly.
 */
export function mergeRepoContributors(
  lists: readonly (readonly ProjectRepoContributor[])[],
): ProjectRepoContributor[] {
  const nonEmpty = lists.filter((list) => list.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return [...nonEmpty[0]];

  const merged = new Map<string, ProjectRepoContributor>();
  for (const contributor of nonEmpty.flat()) {
    const key = contributorKey(contributor);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...contributor });
      continue;
    }
    const newer = contributor.lastCommitAt > existing.lastCommitAt;
    merged.set(key, {
      commitCount: existing.commitCount + contributor.commitCount,
      email: newer ? contributor.email : existing.email,
      lastCommitAt: Math.max(existing.lastCommitAt, contributor.lastCommitAt),
      name: newer ? contributor.name : existing.name,
    });
  }

  return [...merged.values()].sort(
    (left, right) =>
      right.commitCount - left.commitCount ||
      right.lastCommitAt - left.lastCommitAt ||
      left.name.localeCompare(right.name),
  );
}
