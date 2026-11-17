import type { Repository } from "@/features/projects/projectModels";
import type { ImetaEntry } from "@/shared/ui/markdown/types";
import type { ImetaMedia } from "./imetaMediaMarkdown";

/**
 * LOCAL DIVERGENCE: "Edit" on a generated image asks a message composer to
 * start an edit request from it: the image attached, the agent mentioned, its
 * prompt, and the panel set from its sidecar. A chat image goes to the
 * composer in its own pane and reuses its upload; a repository image goes to
 * the project's agent chat (a DM with the agent, opened first), or else the
 * repository's channel, as a file to upload, saving back to its own folder.
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
  /** Who posted the image; preferred as the agent to mention. */
  authorPubkey: string | null;
  image: ImetaMedia | File;
  prompt: string | null;
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

/** A message attachment as composer media, reusing its upload. */
export function imetaMediaFromEntry(
  url: string,
  entry: ImetaEntry | undefined,
): ImetaMedia {
  return {
    url,
    type: entry?.m ?? "image/jpeg",
    sha256: entry?.x ?? "",
    size: entry?.size ?? 0,
    uploaded: 0,
    ...(entry?.dim ? { dim: entry.dim } : {}),
    ...(entry?.thumb ? { thumb: entry.thumb } : {}),
    ...(entry?.image ? { image: entry.image } : {}),
    ...(entry?.filename ? { filename: entry.filename } : {}),
  };
}
