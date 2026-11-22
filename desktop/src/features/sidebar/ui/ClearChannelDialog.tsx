import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  channelMessagesKey,
  channelWindowKey,
} from "@/features/messages/lib/messageQueryKeys";
import { clearChannel } from "@/shared/api/tauriChannels";
import type { Channel } from "@/shared/api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";

/**
 * LOCAL DIVERGENCE: "Clear channel" from the sidebar menu. The menu unmounts
 * on close, so it hands its channel to the one host the sidebar mounts.
 */
let target: Channel | null = null;
const listeners = new Set<() => void>();

function setTarget(channel: Channel | null) {
  target = channel;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestClearChannel(channel: Channel) {
  setTarget(channel);
}

export function ClearChannelDialogHost() {
  const channel = React.useSyncExternalStore(subscribe, () => target);
  const queryClient = useQueryClient();
  const clear = useMutation({
    mutationFn: (channelId: string) => clearChannel(channelId),
    onSuccess: async (_, channelId) => {
      setTarget(null);
      await Promise.all([
        queryClient.resetQueries({ queryKey: channelMessagesKey(channelId) }),
        queryClient.resetQueries({ queryKey: channelWindowKey(channelId) }),
        queryClient.resetQueries({ queryKey: ["thread-replies", channelId] }),
      ]);
    },
  });
  const name = channel ? `#${channel.name}` : "";

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open && !clear.isPending) {
          clear.reset();
          setTarget(null);
        }
      }}
      open={channel !== null}
    >
      <AlertDialogContent data-testid="channel-clear-confirmation-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Clear all messages in {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently remove all messages in {name}. This action
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {clear.error instanceof Error ? (
          <p className="text-sm text-destructive">{clear.error.message}</p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button disabled={clear.isPending} type="button" variant="outline">
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              data-testid="channel-clear-confirm"
              disabled={clear.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (channel) clear.mutate(channel.id);
              }}
              type="button"
              variant="destructive"
            >
              {clear.isPending ? "Clearing..." : "Clear All Messages"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
