import type { Repository } from "@/features/projects/hooks";
import { KIND_DELETION } from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Tombstone for one repository.
 *
 * Deleting a repository is not a soft delete. The relay's `repo_delete` path
 * empties the object-store prefix, drops the ref state and the tasks, reviews
 * and patches, then releases the name reservation — so the git data is gone
 * for everyone and cannot be recovered. Every confirmation built on this has
 * to say so.
 *
 * What it must not touch is the user's local clone. The remote is the thing
 * being destroyed, and someone's working tree is not the relay's to remove.
 */
export type DeletionTemplate = {
  kind: number;
  content: string;
  tags: string[][];
};

/**
 * The relay accepts a tombstone from the coordinate's owner or that pubkey's
 * registered NIP-OA owner. This checks only the direct case: an agent-owned
 * repository is left to the CLI rather than guessed at here.
 */
export function buildRepositoryTombstone({
  ownerPubkey,
  repository,
}: {
  ownerPubkey: string;
  repository: Repository;
}): DeletionTemplate {
  if (normalizePubkey(ownerPubkey) !== normalizePubkey(repository.owner)) {
    throw new Error("Only the repository owner can delete it.");
  }
  return {
    kind: KIND_DELETION,
    content: `Delete repository ${repository.name}`,
    tags: [["a", repository.repoAddress]],
  };
}
