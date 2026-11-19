import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import type { Repository } from "@/features/projects/projectModels";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_REPO_STATE } from "@/shared/constants/kinds";

/**
 * LOCAL DIVERGENCE: refreshes an open repository's files, refs and folders
 * whenever a push lands. The relay publishes the repo's kind:30618 ref state
 * (signed by itself) after every push, from any pusher: an agent saving an
 * image, a move from the image sidebar, a teammate. Without it the Files view
 * kept its snapshot until a manual Fetch.
 */
export function useLiveRepoRefresh(repository: Repository | null | undefined) {
  const queryClient = useQueryClient();
  const id = repository?.id ?? null;
  const owner = repository?.owner ?? null;
  const dtag = repository?.dtag ?? null;

  React.useEffect(() => {
    if (!id || !owner || !dtag) return undefined;
    let cancelled = false;
    let dispose: (() => void) | null = null;
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: ["project", id] });

    void (async () => {
      const relaySelf = await getRelaySelf().catch(() => null);
      if (cancelled) return;
      const authors = [...new Set([owner, relaySelf].filter(Boolean))];
      try {
        const unsubscribe = await relayClient.subscribeLive(
          {
            kinds: [KIND_REPO_STATE],
            authors: authors as string[],
            "#d": [dtag],
            limit: 1,
            since: Math.floor(Date.now() / 1000),
          },
          refresh,
        );
        if (cancelled) unsubscribe();
        else dispose = unsubscribe;
      } catch (error) {
        console.warn("live repo refresh unavailable", error);
      }
    })();
    const unsubscribeReconnect = relayClient.subscribeToReconnects(refresh);

    return () => {
      cancelled = true;
      dispose?.();
      unsubscribeReconnect();
    };
  }, [dtag, id, owner, queryClient]);
}
