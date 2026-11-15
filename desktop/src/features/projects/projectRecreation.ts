import type { ProjectEventTemplate } from "./projectCreation";

/**
 * Re-creating a deleted project. Deletion removes only the project
 * announcement; its home channel and default repository stay behind. Creating
 * a project with the same name re-uses the ones that are yours instead of
 * failing on them.
 */

export type HomeChannelCandidate = {
  archivedAt: string | null;
  channelType: string;
  id: string;
  /** Members whose channel role is owner or admin. */
  managerPubkeys: readonly string[];
  name: string;
  visibility: string;
};

/** The relay keeps one open listed stream per name (upstream #8782). */
function blocksName(channel: HomeChannelCandidate, name: string) {
  return (
    channel.channelType === "stream" &&
    channel.visibility === "open" &&
    channel.name.trim().toLowerCase() === name.trim().toLowerCase()
  );
}

/**
 * The leftover home channel to re-use: first the one the leftover repository
 * is bound to, then an open channel with the project's name. Only channels
 * you own or administer qualify.
 */
export function pickReusableHomeChannel<T extends HomeChannelCandidate>(input: {
  candidates: readonly T[];
  leftoverChannelId: string | null;
  name: string;
  ownerPubkey: string;
}): T | null {
  const owner = input.ownerPubkey.toLowerCase();
  const yours = input.candidates.filter((channel) =>
    channel.managerPubkeys.some((pubkey) => pubkey.toLowerCase() === owner),
  );
  return (
    yours.find((channel) => channel.id === input.leftoverChannelId) ??
    yours.find((channel) => blocksName(channel, input.name)) ??
    null
  );
}

/**
 * A leftover repository announcement re-bound to `channelId`. Every other tag
 * is kept; a missing description is filled in from `description`. Returns
 * null when the repository is already bound there and has a description.
 */
export function rebindRepositoryTemplate(
  repository: { content: string; kind: number; tags: string[][] },
  channelId: string,
  description?: string,
): ProjectEventTemplate | null {
  const boundChannel = repository.tags.find(
    (tag) => tag[0] === "buzz-channel",
  )?.[1];
  const hasDescription = repository.tags.some(
    (tag) => tag[0] === "description" && tag[1]?.trim(),
  );
  const fillDescription = !hasDescription && Boolean(description?.trim());
  if (boundChannel === channelId && !fillDescription) return null;

  const tags = repository.tags.filter((tag) => tag[0] !== "buzz-channel");
  tags.push(["buzz-channel", channelId]);
  let content = repository.content;
  if (fillDescription && description) {
    tags.push(["description", description.trim()]);
    if (!content.trim()) content = description.trim();
  }
  return { kind: repository.kind, content, tags };
}

/** True for the relay's refusal of a second open channel with one name. */
export function isDuplicateChannelNameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /an open channel named .* already exists/i.test(error.message)
  );
}
