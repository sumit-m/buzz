import * as React from "react";

export type HtmlDocument = {
  filename: string;
  load: (signal: AbortSignal) => Promise<string>;
  /** Changes when `load` would return a different file. */
  loadKey: string;
};

let current: HtmlDocument | null = null;
let hosts = 0;
const listeners = new Set<() => void>();

function publish(next: HtmlDocument | null) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Show a document in the docked side panel. Returns false when no screen can
 * dock one, so the caller falls back to a dialog.
 */
export function openHtmlDocument(doc: HtmlDocument): boolean {
  if (hosts === 0) return false;
  publish(doc);
  return true;
}

export function closeHtmlDocument() {
  if (current) publish(null);
}

/** For the screen that docks the document; closes it when that screen goes. */
export function useHtmlDocumentHost(): HtmlDocument | null {
  React.useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
      if (hosts === 0) closeHtmlDocument();
    };
  }, []);
  return React.useSyncExternalStore(subscribe, () => current);
}

export function htmlDocumentHostCountForTests() {
  return hosts;
}
