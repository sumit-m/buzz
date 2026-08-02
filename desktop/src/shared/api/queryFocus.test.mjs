import assert from "node:assert/strict";
import { test } from "node:test";

import { focusManager } from "@tanstack/react-query";

import { installWindowFocusManager } from "./queryFocus.ts";

function fakeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    fire(type) {
      listeners.get(type)?.();
    },
  };
}

function withFakeWindow(visibilityState, run) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const win = fakeTarget();
  const doc = fakeTarget();
  doc.visibilityState = visibilityState;
  globalThis.window = win;
  globalThis.document = doc;
  try {
    return run(win, doc);
  } finally {
    focusManager.setEventListener(() => () => {});
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

test("a window focus event marks the app focused", () => {
  // The bug this exists for: React Query v5 listens only to visibilitychange,
  // which a desktop window never fires when you switch to another app — so
  // every refetchOnWindowFocus opt-in was silently inert.
  withFakeWindow("visible", (win) => {
    installWindowFocusManager();
    win.fire("blur");
    assert.equal(focusManager.isFocused(), false);
    win.fire("focus");
    assert.equal(focusManager.isFocused(), true);
  });
});

test("a window blur event marks the app unfocused", () => {
  withFakeWindow("visible", (win) => {
    installWindowFocusManager();
    win.fire("focus");
    win.fire("blur");
    assert.equal(focusManager.isFocused(), false);
  });
});

test("a hidden document still reports unfocused", () => {
  // A minimised window: honouring visibility avoids refetching for a window
  // nobody is looking at.
  withFakeWindow("hidden", (win, doc) => {
    installWindowFocusManager();
    win.fire("focus");
    doc.fire("visibilitychange");
    assert.equal(focusManager.isFocused(), false);
  });
});

test("cleanup removes every listener it registered", () => {
  withFakeWindow("visible", (win, doc) => {
    const uninstall = installWindowFocusManager();
    assert.equal(win.listeners.size, 2);
    assert.equal(doc.listeners.size, 1);

    uninstall();
    assert.equal(win.listeners.size, 0);
    assert.equal(doc.listeners.size, 0);
  });
});

test("no window means nothing is registered and cleanup is safe", () => {
  const previousWindow = globalThis.window;
  globalThis.window = undefined;
  try {
    const uninstall = installWindowFocusManager();
    assert.doesNotThrow(uninstall);
  } finally {
    globalThis.window = previousWindow;
  }
});
