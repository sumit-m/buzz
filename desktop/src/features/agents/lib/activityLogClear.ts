/**
 * "Clear" for the agent activity log.
 *
 * Unlike the harness log — a file the viewer owns, which its clear truncates —
 * the activity log is a projection of archived observer frames. Those are
 * shared durable data: the same frames back the transcript after a reload, and
 * deleting them would be an irreversible loss for a toolbar button whose intent
 * is only "hide what I have already read".
 *
 * So clearing writes a watermark instead. Frames at or before it stop being
 * rendered; nothing is destroyed, and a later clear can only ever move the
 * watermark forward. It is persisted per (agent, channel) so the panel still
 * looks clear after a reopen — an in-memory reset would be undone by the
 * archive re-hydrating on mount.
 */

const STORAGE_PREFIX = "buzz.activityLogClearedAt";

/** Per (agent, channel) so clearing one channel's log never blanks another. */
export function activityLogClearKey(
  agentPubkey: string,
  channelId: string | null | undefined,
) {
  return `${STORAGE_PREFIX}:${agentPubkey}:${channelId ?? "all"}`;
}

/**
 * Read the watermark, or `null` when the log was never cleared.
 *
 * Storage is treated as untrusted: a value written by an older build, or by
 * hand, must not blank the panel forever. Anything that is not a finite
 * positive number reads as "never cleared".
 */
export function readActivityLogClearedAt(key: string): number | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    // Private-mode or disabled storage: the log simply never stays cleared.
    return null;
  }
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function writeActivityLogClearedAt(key: string, clearedAt: number) {
  try {
    window.localStorage.setItem(key, String(clearedAt));
  } catch {
    // The clear still applies to this session; it just will not survive a
    // reload. Better than failing the button.
  }
}

/**
 * Drop every frame at or before the watermark.
 *
 * `<=` rather than `<`: the watermark is the moment of the click, and a frame
 * bearing exactly that millisecond was already on screen when it happened.
 *
 * A frame whose timestamp does not parse is kept. Hiding it would be the worse
 * failure — an unreadable timestamp is not evidence that the user has seen it.
 */
export function filterEventsAfterClear<T extends { timestamp: string }>(
  events: T[],
  clearedAt: number | null,
): T[] {
  if (clearedAt === null) return events;
  return events.filter((event) => {
    const at = Date.parse(event.timestamp);
    return !Number.isFinite(at) || at > clearedAt;
  });
}
