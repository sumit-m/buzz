import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  type Project,
  projectsQueryKey,
  type Repository,
} from "@/features/projects/hooks";
import { buildProjectPatchTemplate } from "@/features/projects/projectRepositoryCreation";
import { buildRepositoryTombstone } from "@/features/projects/repositoryDeletion";
import { publishProjectOwnerAnnouncement } from "@/shared/api/projectGit";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { KIND_PROJECT_ANNOUNCEMENT } from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type DeleteRepositoryInput = {
  /** The project listing it; a legacy project is the repository itself. */
  project: Project;
  repository: Repository;
};

/**
 * Destroy a repository, then drop its coordinate from the project listing it.
 *
 * The tombstone goes first. If the membership edit then fails, the project is
 * left naming a coordinate that no longer resolves — which the read model
 * already handles as "unavailable" and shows as such. The reverse ordering
 * would leave a repository belonging to nothing while its git data still
 * exists, which nothing on screen would explain.
 */
async function deleteRepository({
  project,
  repository,
}: DeleteRepositoryInput) {
  const identity = await getIdentity();
  const tombstoneEvent = await signRelayEvent(
    buildRepositoryTombstone({ ownerPubkey: identity.pubkey, repository }),
  );
  await relayClient.publishEvent(
    tombstoneEvent,
    "Timed out deleting the repository.",
    "Failed to delete the repository.",
  );

  const owner = normalizePubkey(identity.pubkey);
  // A legacy project is a card synthesised from the repository itself, so
  // there is no announcement to edit. Someone else's project is not ours to
  // rewrite either — it keeps the dead coordinate and renders it unavailable.
  if (project.legacy || normalizePubkey(project.owner) !== owner) {
    return { repository };
  }

  const liveHeads = await relayClient.fetchEvents({
    kinds: [KIND_PROJECT_ANNOUNCEMENT],
    authors: [owner],
    "#d": [project.dtag],
    limit: 1,
  });
  const liveHead = liveHeads[0];
  if (!liveHead) {
    throw new Error(
      `"${repository.name}" was deleted, but ${project.name} could not be updated. Refresh and try again.`,
    );
  }

  const liveAddresses = liveHead.tags
    .filter((tag) => tag[0] === "a" && tag[1])
    .map((tag) => tag[1] as string);
  const remaining = liveAddresses.filter(
    (address) => address !== repository.repoAddress,
  );
  // Already absent — another session dropped it. Republishing would advance
  // the head for nothing.
  if (remaining.length === liveAddresses.length) return { repository };

  const publication = await publishProjectOwnerAnnouncement({
    ...buildProjectPatchTemplate({
      liveHead,
      ownerPubkey: owner,
      repositoryAddresses: remaining,
    }),
    createdAt: Math.max(
      Math.floor(Date.now() / 1_000),
      liveHead.created_at + 1,
    ),
    targetOwner: owner,
  });
  if (publication.publicationError) {
    throw new Error(
      `"${repository.name}" was deleted, but ${project.name} still lists it.`,
    );
  }

  return { repository };
}

export function useDeleteRepositoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteRepository,
    // onSettled, not onSuccess: the tombstone lands before the membership
    // edit, so even a failed run has changed what the relay holds.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}
