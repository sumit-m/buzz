import * as React from "react";

const NO_BRANCHES: string[] = [];

function sameBranches(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((branch, index) => branch === right[index])
  );
}

/**
 * The local checkout's branches as last reported by a sync status.
 *
 * Branch selection needs them before the sync-status query can run, because
 * that query is keyed on the selected branch. Holding the last report across
 * a key change keeps a local-only selection from snapping back to the default
 * branch while the next status loads.
 */
export function useRetainedLocalBranches(repositoryId: string | null) {
  const [retained, setRetained] = React.useState({
    branches: NO_BRANCHES,
    repositoryId,
  });
  const localBranches =
    retained.repositoryId === repositoryId ? retained.branches : NO_BRANCHES;
  const reportLocalBranches = React.useCallback(
    (branches: string[]) => {
      setRetained((current) =>
        current.repositoryId === repositoryId &&
        sameBranches(current.branches, branches)
          ? current
          : { branches, repositoryId },
      );
    },
    [repositoryId],
  );
  return { localBranches, reportLocalBranches };
}
