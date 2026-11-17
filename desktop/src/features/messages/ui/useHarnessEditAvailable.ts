import { useQuery } from "@tanstack/react-query";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { editTargetFor } from "@/features/messages/lib/composerHarnessState";
import { listHarnessComposers } from "@/shared/api/harnessComposer";

/** LOCAL DIVERGENCE: whether a local agent can take an image edit request. */
export function useHarnessEditAvailable(): boolean {
  const composers = useQuery({
    queryKey: ["harness-composers"],
    queryFn: listHarnessComposers,
    staleTime: 60_000,
  });
  const agents = useManagedAgentsQuery();
  return editTargetFor(composers.data ?? [], agents.data ?? [], null) !== null;
}
