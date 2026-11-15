import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

let retainedModule;
let selectionModule;
before(async () => {
  retainedModule = await import("./useRetainedLocalBranches.ts");
  selectionModule = await import("./useProjectRepositoryRefSelection.ts");
});

async function renderRetained(repositoryId) {
  const { act, renderHook } = await import("@testing-library/react");
  const rendered = renderHook(
    (id) => retainedModule.useRetainedLocalBranches(id),
    { initialProps: repositoryId },
  );
  return { act, ...rendered };
}

test("reported branches are kept until the next report", async () => {
  const { act, rerender, result } = await renderRetained("repo-a");
  assert.deepEqual(result.current.localBranches, []);

  act(() => result.current.reportLocalBranches(["main", "feature"]));
  rerender("repo-a");
  assert.deepEqual(result.current.localBranches, ["main", "feature"]);
});

test("an identical report keeps the same array", async () => {
  const { act, result } = await renderRetained("repo-a");
  act(() => result.current.reportLocalBranches(["main", "feature"]));
  const first = result.current.localBranches;

  act(() => result.current.reportLocalBranches(["main", "feature"]));
  assert.equal(result.current.localBranches, first);
});

test("a repository switch drops the previous repository's branches", async () => {
  const { act, rerender, result } = await renderRetained("repo-a");
  act(() => result.current.reportLocalBranches(["main", "feature"]));

  rerender("repo-b");
  assert.deepEqual(result.current.localBranches, []);
});

test("a local-only branch stays selected while the next sync status loads", async () => {
  const { act, renderHook } = await import("@testing-library/react");
  const remoteBranches = ["main"];
  const { rerender, result } = renderHook(
    ({ syncReport }) => {
      const retained = retainedModule.useRetainedLocalBranches("repo-a");
      const branchOptions = [
        ...new Set([...remoteBranches, ...retained.localBranches]),
      ];
      const selection = selectionModule.useProjectRepositoryRefSelection({
        branchOptions,
        defaultBranch: "main",
        projectAvailable: true,
        projectPending: false,
        repositoryId: "repo-a",
        tags: [],
      });
      return { retained, selection, syncReport };
    },
    { initialProps: { syncReport: ["main", "local-only"] } },
  );

  act(() =>
    result.current.retained.reportLocalBranches(result.current.syncReport),
  );
  act(() => result.current.selection.selectBranch("local-only"));
  // The sync status for the new selection has not arrived yet.
  rerender({ syncReport: undefined });
  assert.equal(result.current.selection.activeBranch, "local-only");
});
