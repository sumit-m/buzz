import * as React from "react";
import { toast } from "sonner";

import {
  useDeleteManagedAgentMutation,
  useRelayAgentsQuery,
  useStopManagedAgentMutation,
} from "@/features/agents/hooks";
import { stopManagedAgentWithRules } from "@/features/agents/lib/managedAgentControlActions";
import { clearActiveTurnsForAgentOnStop } from "@/features/agents/managedAgentRuntimeHooks";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useAgentAvailabilityLookup } from "@/features/agents/lib/useAgentAvailability";
import { deleteProfileManagedAgent } from "@/features/profile/ui/UserProfilePanelDeletion";
import { getRelayAgentChannelIds } from "@/features/profile/ui/UserProfilePanelUtils";
import { removeChannelMember } from "@/shared/api/tauri";
import type { ManagedAgent } from "@/shared/api/types";

/**
 * Stop/delete for a *sibling* instance listed in the profile panel's Instances
 * section — the ones the panel is not currently showing. Self-contained rather
 * than threaded down from `UserProfilePanel` so the accordion can act on any
 * instance without that component growing another handler pair; the queries
 * here share React Query keys with the panel's, so they cost no extra fetches.
 */
export function useProfileInstanceActions(instances: readonly ManagedAgent[]) {
  const channelsQuery = useChannelsQuery();
  const relayAgentsQuery = useRelayAgentsQuery();
  const stopMutation = useStopManagedAgentMutation();
  const deleteMutation = useDeleteManagedAgentMutation();
  const { getAvailability } = useAgentAvailabilityLookup(
    React.useMemo(() => instances.map((agent) => agent.pubkey), [instances]),
  );

  const findInstance = React.useCallback(
    (pubkey: string) =>
      instances.find((instance) => instance.pubkey === pubkey),
    [instances],
  );

  const removeFromAllChannels = React.useCallback(
    async (pubkey: string) => {
      const channelIds = new Set(
        getRelayAgentChannelIds(relayAgentsQuery.data, pubkey),
      );
      const normalized = pubkey.toLowerCase();
      for (const channel of channelsQuery.data ?? []) {
        if (
          channel.memberPubkeys.some((key) => key.toLowerCase() === normalized)
        ) {
          channelIds.add(channel.id);
        }
      }
      if (channelIds.size === 0) return;
      await Promise.allSettled(
        [...channelIds].map((channelId) =>
          removeChannelMember(channelId, pubkey),
        ),
      );
    },
    [channelsQuery.data, relayAgentsQuery.data],
  );

  const stopInstance = React.useCallback(
    async (pubkey: string) => {
      const instance = findInstance(pubkey);
      if (!instance) return;

      try {
        const result = await stopManagedAgentWithRules({
          agent: instance,
          channels: channelsQuery.data ?? [],
          relayAgents: relayAgentsQuery.data ?? [],
          stopManagedAgent: stopMutation.mutateAsync,
        });
        if (instance.backend.type === "local") {
          clearActiveTurnsForAgentOnStop(pubkey);
        }
        toast.success(result.noticeMessage ?? `Stopped ${instance.name}.`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to stop agent.",
        );
      }
    },
    [
      channelsQuery.data,
      findInstance,
      relayAgentsQuery.data,
      stopMutation.mutateAsync,
    ],
  );

  const deleteInstance = React.useCallback(
    async (pubkey: string) => {
      const instance = findInstance(pubkey);
      if (!instance) return;

      try {
        const result = await deleteProfileManagedAgent(instance, {
          channels: channelsQuery.data ?? [],
          deleteManagedAgent: deleteMutation.mutateAsync,
          getAvailability,
          relayAgents: relayAgentsQuery.data ?? [],
          removeAgentFromAllChannels: removeFromAllChannels,
        });
        if (result.cancelled) return;
        toast.success(`Deleted ${instance.name}.`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete agent.",
        );
      }
    },
    [
      channelsQuery.data,
      deleteMutation.mutateAsync,
      findInstance,
      getAvailability,
      relayAgentsQuery.data,
      removeFromAllChannels,
    ],
  );

  const isPending = stopMutation.isPending || deleteMutation.isPending;

  return { deleteInstance, isPending, stopInstance };
}
