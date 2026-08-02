import { maxReadAt } from "@/features/channels/readState/readStateFormat";

export type ObservedUnreadEvent = {
  id: string;
  createdAt: number;
  rootId: string | null;
  highPriority: boolean;
  countsTowardBadge: boolean;
  countsTowardAppBadge: boolean;
};

export function makeObservedUnreadEvent(input: {
  id: string;
  createdAt: number;
  rootId: string | null;
  highPriority: boolean;
  channelType: string | undefined;
  isThreadedReply: boolean;
}): ObservedUnreadEvent {
  const isDm = input.channelType === "dm";
  return {
    id: input.id,
    createdAt: input.createdAt,
    rootId: input.rootId,
    highPriority: input.highPriority,
    countsTowardBadge: isDm || input.isThreadedReply || input.highPriority,
    countsTowardAppBadge:
      isDm || (!input.isThreadedReply && input.highPriority),
  };
}

export function mapsEqual(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

export function recordObservedUnreadEvent(
  eventsByChannel: Map<string, Map<string, ObservedUnreadEvent>>,
  channelId: string,
  event: ObservedUnreadEvent,
  limit: number,
): boolean {
  let eventsById = eventsByChannel.get(channelId);
  if (!eventsById) {
    eventsById = new Map<string, ObservedUnreadEvent>();
    eventsByChannel.set(channelId, eventsById);
  }
  if (eventsById.has(event.id)) return false;

  eventsById.set(event.id, event);
  if (eventsById.size <= limit) return true;

  const oldest = [...eventsById.values()].sort(
    (a, b) => a.createdAt - b.createdAt,
  )[0]?.id;
  if (oldest) {
    eventsById.delete(oldest);
  }
  return true;
}

/**
 * Forget observed unread events named by a deletion.
 *
 * Badge counts are derived from this map, not from the home-inbox activity
 * rows, so a destroyed message keeps counting until its id is dropped here.
 * A top-level DM has no activity row at all, which is why deleting one used to
 * leave its badge behind entirely.
 *
 * Scans every channel rather than taking a channel id: a cascade names the
 * whole destroyed subtree, and the caller has the ids without knowing which
 * channel each belonged to.
 */
export function removeObservedUnreadEvents(
  eventsByChannel: Map<string, Map<string, ObservedUnreadEvent>>,
  deletedIds: ReadonlySet<string>,
): boolean {
  if (deletedIds.size === 0) return false;
  let removed = false;
  for (const eventsById of eventsByChannel.values()) {
    for (const id of deletedIds) {
      if (eventsById.delete(id)) removed = true;
    }
  }
  return removed;
}

export function countUnreadObservedEvents(
  eventsById: ReadonlyMap<string, ObservedUnreadEvent> | undefined,
  getReadAt: (event: ObservedUnreadEvent) => number | null,
): number {
  if (!eventsById) return 0;
  let count = 0;
  for (const event of eventsById.values()) {
    const readAt = getReadAt(event);
    if (readAt === null || event.createdAt > readAt) count += 1;
  }
  return count;
}

export function hasUnreadTopLevelObservedEvent(
  eventsById: ReadonlyMap<string, ObservedUnreadEvent> | undefined,
  getReadAt: (event: ObservedUnreadEvent) => number | null,
): boolean {
  if (!eventsById) return false;
  for (const event of eventsById.values()) {
    if (event.rootId !== null) continue;
    const readAt = getReadAt(event);
    if (readAt === null || event.createdAt > readAt) return true;
  }
  return false;
}

export function countUnreadBadgeObservedEvents(
  eventsById: ReadonlyMap<string, ObservedUnreadEvent> | undefined,
  getReadAt: (event: ObservedUnreadEvent) => number | null,
): number {
  if (!eventsById) return 0;
  let count = 0;
  for (const event of eventsById.values()) {
    if (!event.countsTowardBadge) continue;
    const readAt = getReadAt(event);
    if (readAt === null || event.createdAt > readAt) count += 1;
  }
  return count;
}

export function countUnreadAppBadgeObservedEvents(
  eventsById: ReadonlyMap<string, ObservedUnreadEvent> | undefined,
  getReadAt: (event: ObservedUnreadEvent) => number | null,
): number {
  if (!eventsById) return 0;
  let count = 0;
  for (const event of eventsById.values()) {
    if (!event.countsTowardAppBadge) continue;
    const readAt = getReadAt(event);
    if (readAt === null || event.createdAt > readAt) count += 1;
  }
  return count;
}

export function countUnreadHighPriorityObservedEvents(
  eventsById: ReadonlyMap<string, ObservedUnreadEvent> | undefined,
  getReadAt: (event: ObservedUnreadEvent) => number | null,
): number {
  if (!eventsById) return 0;
  let count = 0;
  for (const event of eventsById.values()) {
    if (!event.highPriority) continue;
    const readAt = getReadAt(event);
    if (readAt === null || event.createdAt > readAt) count += 1;
  }
  return count;
}

export function observedUnreadEventReadAt(
  event: ObservedUnreadEvent,
  channelReadAt: number | null,
  getThreadOwnMarker: (rootId: string) => number | null,
  getMessageOwnMarker: (messageId: string) => number | null = () => null,
): number | null {
  const markers = [channelReadAt, getMessageOwnMarker(event.id)];

  if (event.rootId !== null) {
    markers.push(getThreadOwnMarker(event.rootId));
  }

  return maxReadAt(...markers);
}
