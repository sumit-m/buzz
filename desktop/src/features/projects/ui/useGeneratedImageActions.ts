import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useChannelsQuery, useOpenDmMutation } from "@/features/channels/hooks";
import {
  composerPayload,
  composerTag,
  editTargetFor,
  stateFromSidecar,
} from "@/features/messages/lib/composerHarnessState";
import {
  composerDraftKeyNear,
  openProjectChat,
  PROJECT_CHAT_DRAFT_KEY_PREFIX,
  requestHarnessEdit,
} from "@/features/messages/lib/harnessEditRequest";
import { useSendMessageMutation } from "@/features/messages/hooks";
import { useProjectsQuery } from "@/features/projects/hooks";
import {
  type CommitAdd,
  candidateRepositories,
  canRegenerate,
  regenerateSetup,
  fileName,
  folderLabel,
  imetaFromSource,
  folderOf,
  type ImageLocation,
  locationFromMatches,
  parseRepoValue,
  planRelocation,
  regenerateMessage,
  repoValueFor,
  sourceRepoPath,
} from "@/features/projects/lib/generatedImage";
import type { Repository } from "@/features/projects/projectModels";
import {
  commitProjectRepoFiles,
  findProjectRepoFiles,
  listHarnessComposers,
  type RepoFileAdd,
} from "@/shared/api/harnessComposer";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  getProjectRepoFileBytes,
  uploadProjectRepoFile,
} from "@/shared/api/projectGit";
import {
  type ImageSidecar,
  type SidecarSource,
  sidecarPathFor,
} from "./imageSidecar";

/** Where a generated image's sidebar is shown. */
export type GeneratedImageContext =
  | {
      kind: "chat";
      /** The message's image and sidecar uploads. */
      imageUrl: string;
      sidecarUrl: string | null;
    }
  | {
      kind: "repo";
      repository: Repository;
      path: string;
      onOpenPath?: (path: string) => void;
    };

const CHANNEL_ATTRIBUTE = "data-message-channel";
const AUTHOR_ATTRIBUTE = "data-message-author";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

async function resolveAdd(add: CommitAdd): Promise<RepoFileAdd | null> {
  if ("url" in add) return add;
  const { repository, path } = add.from;
  const bytes = await getProjectRepoFileBytes({
    cloneUrl: repository.cloneUrls[0] ?? "",
    defaultBranch: repository.defaultBranch || null,
    path,
  });
  if (!bytes) {
    if (add.optional) return null;
    throw new Error(`Could not read ${path}`);
  }
  return { path: add.path, contentBase64: toBase64(bytes) };
}

/**
 * The sources as uploads, each taken from the repo's `.sources/` copy when
 * it has one, so a request can be made again after the original upload is
 * gone. A source the repo lacks keeps its own upload.
 */
async function sourcesFromRepo(
  sources: readonly SidecarSource[],
  repository: Repository | null | undefined,
): Promise<SidecarSource[]> {
  const cloneUrl = repository?.cloneUrls[0];
  if (!repository || !cloneUrl) return [...sources];
  return Promise.all(
    sources.map(async (source) => {
      const path = sourceRepoPath(source);
      if (!path) return source;
      try {
        const blob = await uploadProjectRepoFile({
          cloneUrl,
          defaultBranch: repository.defaultBranch || null,
          path,
        });
        return {
          url: blob.url,
          m: blob.type,
          x: blob.sha256,
          size: String(blob.size),
          path,
          ...(blob.dim ? { dim: blob.dim } : {}),
        };
      } catch {
        return source;
      }
    }),
  );
}

/**
 * LOCAL DIVERGENCE: the image info sidebar's repo button and Regenerate. The
 * image's repo location is looked up by file name in the repos it may be in
 * (only when asked), so a move made anywhere is still found. Regenerate goes
 * to the message's channel, or for a repository file to a DM with the agent;
 * Edit loads that same request into the composer there, unsent.
 */
export function useGeneratedImageActions({
  context,
  rootRef,
  sidecar,
}: {
  context: GeneratedImageContext | undefined;
  rootRef: React.RefObject<HTMLElement | null>;
  sidecar: ImageSidecar;
}) {
  const queryClient = useQueryClient();
  const projects = useProjectsQuery();
  const channels = useChannelsQuery();
  const agents = useManagedAgentsQuery();
  const identity = useIdentityQuery();
  const sendMessage = useSendMessageMutation(null, identity.data);
  const openDm = useOpenDmMutation();
  const composers = useQuery({
    queryKey: ["harness-composers"],
    queryFn: listHarnessComposers,
    staleTime: 60_000,
  });

  const [message, setMessage] = React.useState<{
    channelId: string | null;
    authorPubkey: string | null;
  }>({ channelId: null, authorPubkey: null });
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    setMessage({
      channelId:
        root
          ?.closest(`[${CHANNEL_ATTRIBUTE}]`)
          ?.getAttribute(CHANNEL_ATTRIBUTE) ?? null,
      authorPubkey:
        root
          ?.closest(`[${AUTHOR_ATTRIBUTE}]`)
          ?.getAttribute(AUTHOR_ATTRIBUTE) ?? null,
    });
  }, [rootRef]);

  const current = context?.kind === "repo" ? context.repository : null;
  const channelId = current ? (current.channelId ?? null) : message.channelId;
  const repositories = React.useMemo(
    () =>
      candidateRepositories(
        (projects.data ?? []).flatMap((project) => project.repositories),
        { channelId, current, originRepo: sidecar.origin?.repo ?? null },
      ),
    [channelId, current, projects.data, sidecar.origin?.repo],
  );
  const imageName =
    sidecar.values.name ??
    (context?.kind === "repo" ? fileName(context.path) : null);
  const viewedPath = context?.kind === "repo" ? context.path : null;

  const locationKey = [
    "generated-image-location",
    imageName,
    repositories.map((repository) => repository.id).join(","),
  ];
  const findLocation = React.useCallback(async () => {
    if (!imageName) return null;
    for (const repository of repositories) {
      const cloneUrl = repository.cloneUrls[0];
      if (!cloneUrl) continue;
      const matches = await findProjectRepoFiles({
        cloneUrl,
        branch: repository.defaultBranch || null,
        names: [imageName, sidecarPathFor(imageName)],
      });
      const found = locationFromMatches(
        repository,
        matches,
        imageName,
        repository.id === current?.id ? viewedPath : null,
      );
      if (found) return found;
    }
    return null;
  }, [current?.id, imageName, repositories, viewedPath]);
  const [locationWanted, setLocationWanted] = React.useState(false);
  const location = useQuery({
    enabled: locationWanted && Boolean(imageName),
    queryKey: locationKey,
    queryFn: findLocation,
    staleTime: 30_000,
  });
  const fetchLocation = () =>
    queryClient.fetchQuery({
      queryKey: locationKey,
      queryFn: findLocation,
      staleTime: 30_000,
    });

  const target = editTargetFor(
    composers.data ?? [],
    agents.data ?? [],
    message.authorPubkey,
    sidecar.values,
  );
  const findChannel = (id: string | null | undefined) =>
    id
      ? (channels.data ?? []).find((candidate) => candidate.id === id)
      : undefined;
  /**
   * Why a move can't commit to `repository`: like a save, the viewer must own
   * it or be in its bound channel, and the agent committing must be able to
   * push there (owner or channel member).
   */
  const pushBlock = (
    repository: Repository,
    agent: { name: string; pubkey: string },
  ): string | null => {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const bound = findChannel(repository.channelId);
    const viewer = identity.data?.pubkey ?? "";
    if (!same(repository.owner, viewer) && !bound?.isMember) {
      return `You're not in ${repository.name}'s channel`;
    }
    const agentIn = bound?.memberPubkeys.some((pubkey) =>
      same(pubkey, agent.pubkey),
    );
    if (!same(repository.owner, agent.pubkey) && !agentIn) {
      return `${agent.name} can't push to ${repository.name}`;
    }
    return null;
  };

  const [moving, setMoving] = React.useState(false);
  const relocate = async (value: string) => {
    const parsed = parseRepoValue(value);
    const destination = parsed
      ? repositories.find(
          (repository) =>
            repository.dtag === parsed.dtag &&
            (!parsed.owner || repository.owner === parsed.owner),
        )
      : undefined;
    if (!parsed || !destination || !imageName) return;
    if (!target) {
      toast.error("No image agent to make the move");
      return;
    }
    const { agent } = target;
    setMoving(true);
    try {
      const from = await fetchLocation();
      const plan = planRelocation({
        attachments:
          context?.kind === "chat"
            ? { imageUrl: context.imageUrl, sidecarUrl: context.sidecarUrl }
            : null,
        folder: parsed.folder,
        imageName,
        location: from,
        sources: sidecar.origin?.sources ?? [],
        target: destination,
      });
      if (!plan) {
        toast.message(
          from ? "The image is already there" : "Nothing to copy from",
        );
        return;
      }
      const blocked = plan.commits
        .map((commit) => pushBlock(commit.repository, agent))
        .find((reason) => reason !== null);
      if (blocked) {
        toast.error(blocked);
        return;
      }
      for (const commit of plan.commits) {
        await commitProjectRepoFiles({
          agentPubkey: agent.pubkey,
          cloneUrl: commit.repository.cloneUrls[0] ?? "",
          branch: commit.repository.defaultBranch || null,
          renames: commit.renames,
          adds: (await Promise.all(commit.adds.map(resolveAdd))).filter(
            (add): add is RepoFileAdd => add !== null,
          ),
          deletes: commit.deletes,
          message: commit.message,
        });
      }
      const { repository, imagePath } = plan.destination;
      const moved: ImageLocation = {
        repository,
        imagePath,
        sidecarPath:
          !from || from.sidecarPath ? sidecarPathFor(imagePath) : null,
      };
      queryClient.setQueryData(locationKey, moved);
      for (const commit of plan.commits) {
        void queryClient.invalidateQueries({
          queryKey: ["project", commit.repository.id],
        });
      }
      toast.success(
        `${from ? "Moved" : "Copied"} to ${repository.name}: ${folderLabel(parsed.folder)}`,
      );
      if (context?.kind === "repo" && repository.id === context.repository.id) {
        context.onOpenPath?.(imagePath);
      }
    } catch (error) {
      toast.error(
        `Could not move the image: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setMoving(false);
    }
  };

  const origin = sidecar.origin;
  const inDm = context?.kind === "repo";
  const channel = findChannel(channelId);
  const regenerateBlocked = (() => {
    if (inDm) return null;
    if (!channelId) return "This message isn't in a channel";
    if (!channel?.isMember) return "Join the channel to regenerate";
    if (
      target &&
      !channel.memberPubkeys.some(
        (pubkey) => pubkey.toLowerCase() === target.agent.pubkey.toLowerCase(),
      )
    ) {
      return `${target.agent.name} isn't in #${channel.name}`;
    }
    return null;
  })();
  const [regenerating, setRegenerating] = React.useState(false);
  const regenerate = async () => {
    if (!origin || !target || !sidecar.prompt || (!inDm && !channel)) return;
    setRegenerating(true);
    try {
      const saved = await fetchLocation().catch(() => null);
      const { agent, harness } = target;
      const { images, options } = regenerateSetup(origin);
      const state = stateFromSidecar(
        harness.composer,
        sidecar.values,
        saved ? repoValueFor(saved) : null,
        images,
        options,
      );
      const outgoing = regenerateMessage({
        agentName: agent.name,
        prompt: sidecar.prompt,
        sources: inDm
          ? await sourcesFromRepo(origin.sources, saved?.repository ?? current)
          : origin.sources,
      });
      const destination = inDm
        ? await openDm.mutateAsync({ pubkeys: [agent.pubkey] })
        : channel;
      if (!destination) return;
      await sendMessage.mutateAsync({
        channelId: destination.id,
        content: outgoing.content,
        mentionPubkeys: [agent.pubkey],
        mediaTags: [
          ...(outgoing.mediaTags ?? []),
          composerTag(
            harness.harnessId,
            composerPayload(state, harness.composer),
          ),
        ],
      });
      toast.success(
        inDm
          ? `Regenerating in your DM with ${agent.name}`
          : `Regenerating in #${destination.name}`,
      );
    } catch (error) {
      toast.error(
        `Could not regenerate: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setRegenerating(false);
    }
  };

  /** Regenerate's request in the composer: the chat's own, or the project's agent chat. */
  const edit = async (button: HTMLElement) => {
    if (!origin || !target || !sidecar.prompt) return;
    const draftKey = inDm
      ? PROJECT_CHAT_DRAFT_KEY_PREFIX
      : composerDraftKeyNear(button);
    if (!draftKey || (inDm && !openProjectChat())) {
      toast.error(
        inDm
          ? "Open the project's agent chat to edit this"
          : "Open the message box to edit this",
      );
      return;
    }
    const saved = await fetchLocation().catch(() => null);
    const sources = inDm
      ? await sourcesFromRepo(origin.sources, saved?.repository ?? current)
      : origin.sources;
    requestHarnessEdit({
      authorPubkey: target.agent.pubkey,
      draftKey,
      media: sources.map(imetaFromSource),
      prompt: sidecar.prompt,
      repo: saved ? repoValueFor(saved) : null,
      repository: saved?.repository ?? current ?? undefined,
      setup: regenerateSetup(origin),
      values: sidecar.values,
    });
  };
  const available =
    context && canRegenerate(origin) && target && sidecar.prompt;

  return {
    edit: available ? edit : null,
    location: {
      data: location.data,
      folder: location.data ? folderOf(location.data.imagePath) : null,
      isLoading: location.isFetching && location.data === undefined,
      isError: location.isError,
    },
    moving,
    regenerate: available
      ? { blocked: regenerateBlocked, regenerating, run: regenerate }
      : null,
    relocate,
    repositories,
    requestLocation: () => setLocationWanted(true),
  };
}
