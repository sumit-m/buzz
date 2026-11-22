import type { Repository } from "@/features/projects/projectModels";
import type { ImetaMedia } from "./imetaMediaMarkdown";

/**
 * LOCAL DIVERGENCE: "Edit" on a generated image or video loads the request
 * that made it into a message composer, unsent: Regenerate's request, open
 * for changes. Its sources are attached (reusing their uploads), the agent
 * mentioned with the prompt, and the panel set from the sidecar. A chat file
 * goes to the composer in its own pane; a repository file to the project's
 * agent chat (a DM with the agent, opened first).
 *
 * A request waits briefly for its composer, so one that mounts after the
 * navigation still takes it.
 */
export type HarnessEditRequest = {
  /**
   * The composer that should take the request (see `composerDraftKeyNear`);
   * one ending in `:` is taken by any composer whose key starts with it.
   */
  draftKey: string;
  /** The agent that made the file; preferred as the agent to mention. */
  authorPubkey: string | null;
  /** The request's own attachments, its sources in order. */
  media: ImetaMedia[];
  prompt: string | null;
  /** What the sources attach, and the mode and picks the sidecar's origin keeps. */
  setup: {
    images: number;
    options: { mode?: string; picks: Record<string, string>; videos: number };
  };
  /** Where to save (`<owner>/<repo>:<folder>`); left out, the channel's last. */
  repo?: string | null;
  /** Offered in the repo picker even when not bound to the composer's channel. */
  repository?: Repository;
  values: Record<string, string>;
};

const EVENT = "buzz:harness-edit-request";
const PENDING_FOR_MS = 15_000;
const pending = new Map<string, { at: number; request: HarnessEditRequest }>();
/** Draft keys of the project agent chat's composer start with this. */
export const PROJECT_CHAT_DRAFT_KEY_PREFIX = "project-agent:";

let projectChatOpener: (() => void) | null = null;

/** The project screen showing the agent chat registers how to open it. */
export function registerProjectChatOpener(open: () => void): () => void {
  projectChatOpener = open;
  return () => {
    if (projectChatOpener === open) projectChatOpener = null;
  };
}

/** Opens the project agent chat, or returns false when no screen offers one. */
export function openProjectChat(): boolean {
  if (!projectChatOpener) return false;
  projectChatOpener();
  return true;
}

const AGENT_EVENT = "buzz:harness-edit-agent";
/** The agent each composer's loaded edit mentions, by draft key. */
const editAgents = new Map<string, string>();

/** Records (or with null, clears) the agent an edit loaded into `draftKey`'s composer. */
export function setHarnessEditAgent(draftKey: string, pubkey: string | null) {
  if (pubkey) editAgents.set(draftKey, pubkey);
  else editAgents.delete(draftKey);
  window.dispatchEvent(new Event(AGENT_EVENT));
}

export function harnessEditAgentFor(draftKey: string): string | null {
  return editAgents.get(draftKey) ?? null;
}

export function onHarnessEditAgentChange(handler: () => void): () => void {
  window.addEventListener(AGENT_EVENT, handler);
  return () => window.removeEventListener(AGENT_EVENT, handler);
}

const DRAFT_KEY_ATTRIBUTE = "data-composer-draft-key";
const AUTHOR_ATTRIBUTE = "data-message-author";

export function requestHarnessEdit(request: HarnessEditRequest) {
  pending.set(request.draftKey, { at: Date.now(), request });
  window.dispatchEvent(new Event(EVENT));
}

/** The request waiting for `draftKey`'s composer, removed as it's taken. */
export function takeHarnessEditRequest(
  draftKey: string,
): HarnessEditRequest | null {
  const key = [...pending.keys()].find(
    (target) =>
      target === draftKey ||
      (target.endsWith(":") && draftKey.startsWith(target)),
  );
  if (key === undefined) return null;
  const entry = pending.get(key);
  pending.delete(key);
  return entry && Date.now() - entry.at < PENDING_FOR_MS ? entry.request : null;
}

/**
 * Calls `handler` on each new request; it takes the one meant for its
 * composer with `takeHarnessEditRequest`.
 */
export function onHarnessEditRequest(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** The draft key of the nearest message composer sharing a pane with `element`. */
export function composerDraftKeyNear(element: Element): string | null {
  for (
    let ancestor = element.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const composer = ancestor.querySelector(`[${DRAFT_KEY_ATTRIBUTE}]`);
    if (composer) return composer.getAttribute(DRAFT_KEY_ATTRIBUTE);
  }
  return null;
}

export function messageAuthorNear(element: Element): string | null {
  return (
    element.closest(`[${AUTHOR_ATTRIBUTE}]`)?.getAttribute(AUTHOR_ATTRIBUTE) ??
    null
  );
}
