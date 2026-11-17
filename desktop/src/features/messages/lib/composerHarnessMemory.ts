/**
 * LOCAL DIVERGENCE: each channel remembers the last request sent to a
 * harness panel (prompt included), per viewer and device.
 */

import type { SavedComposerState } from "./composerHarnessState";

const PREFIX = "buzz.composer";

function key(channelId: string, harnessId: string) {
  return `${PREFIX}.${channelId}.${harnessId}`;
}

export function loadComposerMemory(
  channelId: string | null,
  harnessId: string,
): SavedComposerState | null {
  if (!channelId) return null;
  try {
    const raw = localStorage.getItem(key(channelId, harnessId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object"
      ? (parsed as SavedComposerState)
      : null;
  } catch {
    return null;
  }
}

export function saveComposerMemory(
  channelId: string | null,
  harnessId: string,
  state: SavedComposerState,
) {
  if (!channelId) return;
  try {
    localStorage.setItem(key(channelId, harnessId), JSON.stringify(state));
  } catch {}
}
