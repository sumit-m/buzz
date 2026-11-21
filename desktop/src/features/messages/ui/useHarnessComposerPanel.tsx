import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import {
  loadComposerMemory,
  saveComposerMemory,
} from "@/features/messages/lib/composerHarnessMemory";
import {
  type ComposerPanelState,
  composerPayload,
  composerTag,
  controlShown,
  editStateFromSidecar,
  editTargetFor,
  followAttachments,
  harnessComposerForAgent,
  imageRules,
  initialPanelState,
  resolvePanel,
  sendBlockReason,
  toSavedState,
} from "@/features/messages/lib/composerHarnessState";
import {
  type HarnessEditRequest,
  onHarnessEditRequest,
  takeHarnessEditRequest,
} from "@/features/messages/lib/harnessEditRequest";
import {
  type AttachedImage,
  imageRefContent,
  syncImageRefsTransaction,
} from "@/features/messages/lib/harnessImageRefNode";
import type { ImetaMedia } from "@/features/messages/lib/imetaMediaMarkdown";
import type { DraftMentionRef } from "@/features/messages/lib/useDrafts";
import { useProjectsQuery } from "@/features/projects/hooks";
import type { Repository } from "@/features/projects/projectModels";
import { listHarnessComposers } from "@/shared/api/harnessComposer";
import {
  ComposerHarnessControls,
  ComposerHarnessModeToggle,
} from "./ComposerHarnessPanel";
import { useHarnessHandles } from "./useHarnessHandles";

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The draft text without the agent's mention. */
function promptTextFor(text: string, agentName: string) {
  return text
    .replace(new RegExp(`@${escapeRegExp(agentName)}\\b`, "gi"), "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * LOCAL DIVERGENCE: shows a harness's declared panel when the draft mentions
 * (or addresses) a local agent running on that harness, and supplies the
 * hidden `buzz-composer` tag on send. Each channel restores its last request.
 *
 * "Edit" on a generated chat image (see `harnessEditRequest`) loads that image,
 * its agent and prompt into the draft, with the panel set from its sidecar.
 * Those settings hold only for that draft: once the mention is gone, the next
 * mention restores the channel's last request again.
 */
export function useHarnessComposerPanel({
  addressedPubkeys,
  channelId,
  draftKey,
  editor,
  enabled,
  extraRepositoryAddresses,
  imageCount,
  images,
  loadDraft,
  mentionNames,
  mentionPubkeys,
  text,
  videoCount,
}: {
  addressedPubkeys: readonly string[];
  channelId: string | null;
  draftKey: string | null;
  editor: Editor | null;
  enabled: boolean;
  /** Repos listed in the picker besides the channel's own (by address). */
  extraRepositoryAddresses?: readonly string[];
  imageCount: number;
  /** The draft's uploaded images, in attachment order, by original URL. */
  images: readonly AttachedImage[];
  /** Mentions this agent and attaches this image in place of the draft's. */
  loadDraft: (draft: {
    image: ImetaMedia | File;
    mention: DraftMentionRef;
  }) => void;
  /** Names Buzz highlights as mentions; never prompt handles. */
  mentionNames: readonly string[];
  mentionPubkeys: readonly string[];
  text: string;
  videoCount: number;
}) {
  const composers = useQuery({
    queryKey: ["harness-composers"],
    queryFn: listHarnessComposers,
    staleTime: 60_000,
  });
  const agents = useManagedAgentsQuery();
  const projects = useProjectsQuery();

  const candidateKey = [...mentionPubkeys, ...addressedPubkeys].join(",");
  const active = React.useMemo(() => {
    if (!enabled || !composers.data?.length || !agents.data) return null;
    for (const pubkey of candidateKey.split(",").filter(Boolean)) {
      const agent = agents.data.find(
        (candidate) => candidate.pubkey.toLowerCase() === pubkey.toLowerCase(),
      );
      const harness = agent
        ? harnessComposerForAgent(composers.data, agent)
        : null;
      if (agent && harness) return { agent, harness };
    }
    return null;
  }, [agents.data, candidateKey, composers.data, enabled]);

  const spec = active?.harness.composer ?? null;
  const harnessId = active?.harness.harnessId ?? null;
  const panelKey = harnessId ? `${channelId ?? ""}:${harnessId}` : null;

  // The harness may rewrite its panel (mage refreshes its presets when it
  // starts), and this composer stays mounted, so re-read it on each mention.
  const refetchComposers = composers.refetch;
  const isActive = panelKey !== null;
  React.useEffect(() => {
    if (isActive) void refetchComposers();
  }, [isActive, refetchComposers]);
  const statesRef = React.useRef(new Map<string, ComposerPanelState>());
  /** Panel keys whose kept state came from an image edit. */
  const editKeysRef = React.useRef(new Set<string>());
  const loadDraftRef = React.useRef(loadDraft);
  loadDraftRef.current = loadDraft;
  const [editRepositories, setEditRepositories] = React.useState<Repository[]>(
    [],
  );
  const [state, setStateRaw] = React.useState<ComposerPanelState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const imageCountRef = React.useRef(imageCount);
  const videoCountRef = React.useRef(videoCount);

  const setState = React.useCallback(
    (next: ComposerPanelState) => {
      if (panelKey) statesRef.current.set(panelKey, next);
      setStateRaw(next);
      setError(null);
    },
    [panelKey],
  );

  // Activation: reuse this draft's picks, else restore the channel's last request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per activation; the editor, agent and spec are read at that moment
  React.useEffect(() => {
    if (!panelKey || !spec || !harnessId || !active) {
      for (const key of editKeysRef.current) statesRef.current.delete(key);
      editKeysRef.current.clear();
      setStateRaw(null);
      return;
    }
    const kept = statesRef.current.get(panelKey);
    if (kept) {
      setStateRaw(kept);
      return;
    }
    const saved = loadComposerMemory(channelId, harnessId);
    const initial = followAttachments(
      initialPanelState(spec, saved),
      spec,
      imageCountRef.current,
      videoCountRef.current,
    );
    statesRef.current.set(panelKey, initial);
    setStateRaw(initial);
    const prompt = saved?.prompt?.trim();
    if (
      prompt &&
      editor &&
      !promptTextFor(editor.getText(), active.agent.name)
    ) {
      const needsSpace = !/\s$/.test(editor.getText());
      editor
        .chain()
        .focus("end")
        .insertContent(needsSpace ? ` ${prompt}` : prompt)
        .run();
      const to = editor.state.selection.to;
      editor.commands.setTextSelection({ from: to - prompt.length, to });
    }
  }, [panelKey]);

  const applyEdit = (request: HarnessEditRequest) => {
    if (!editor || editor.isDestroyed) return;
    const target = editTargetFor(
      composers.data ?? [],
      agents.data ?? [],
      request.authorPubkey,
      request.values,
    );
    if (!target) return;
    const { agent, harness } = target;
    const key = `${channelId ?? ""}:${harness.harnessId}`;
    const repo =
      request.repo !== undefined
        ? request.repo
        : (loadComposerMemory(channelId, harness.harnessId)?.repo ?? null);
    const next = editStateFromSidecar(
      harness.composer,
      request.values,
      repo,
      request.image.type.startsWith("video/"),
    );
    statesRef.current.set(key, next);
    editKeysRef.current.add(key);
    const offered = request.repository;
    if (offered) {
      setEditRepositories((current) => [
        ...current.filter((repository) => repository.id !== offered.id),
        offered,
      ]);
    }
    if (key === panelKey) {
      setStateRaw(next);
      setError(null);
    }
    loadDraftRef.current({
      image: request.image,
      mention: { displayName: agent.name, isAgent: true, pubkey: agent.pubkey },
    });
    const prompt = (request.prompt ?? "").replace(/\s+/g, " ").trim();
    editor
      .chain()
      .focus()
      .clearContent()
      .insertContent({ type: "text", text: `@${agent.name} ${prompt}` })
      .run();
    const to = editor.state.selection.to;
    editor.commands.setTextSelection({ from: to - prompt.length, to });
  };
  const applyEditRef = React.useRef(applyEdit);
  applyEditRef.current = applyEdit;
  const editReady =
    enabled && Boolean(editor && composers.data && agents.data && draftKey);

  // Image edits: one already waiting when this composer mounts (it opened the
  // channel), then new ones. Applied a frame later, after the draft restore.
  React.useEffect(() => {
    if (!editReady || !draftKey) return undefined;
    const take = () => {
      const request = takeHarnessEditRequest(draftKey);
      if (request) requestAnimationFrame(() => applyEditRef.current(request));
    };
    take();
    return onHarnessEditRequest(take);
  }, [draftKey, editReady]);

  // Attachments drive Auto, the image limit and (in a file with one) the mode.
  imageCountRef.current = imageCount;
  videoCountRef.current = videoCount;
  React.useEffect(() => {
    if (!spec || !state) return;
    if (state.images === imageCount && state.videos === videoCount) return;
    setState(followAttachments(state, spec, imageCount, videoCount));
  }, [imageCount, setState, spec, state, videoCount]);

  const extraAddressKey = (extraRepositoryAddresses ?? []).join(" ");
  const repositories = React.useMemo(() => {
    const extraAddresses = new Set(extraAddressKey.split(" "));
    const byId = new Map<string, Repository>(
      editRepositories.map((repository) => [repository.id, repository]),
    );
    for (const project of projects.data ?? []) {
      for (const repository of project.repositories) {
        if (
          (channelId && repository.channelId === channelId) ||
          extraAddresses.has(repository.repoAddress)
        ) {
          byId.set(repository.id, repository);
        }
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [channelId, editRepositories, extraAddressKey, projects.data]);

  // Image references follow the attachments: renumbered, or gone with their upload.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const tr = syncImageRefsTransaction(editor.state, images);
    if (tr) editor.view.dispatch(tr);
  }, [editor, images]);

  const visible = Boolean(spec && state);
  const imageRefsOn = Boolean(
    spec && state && imageRules(state, spec).refs && images.length > 0,
  );
  // Menus a model lacks (Character on FLUX 2) leave the autocomplete too.
  const shownSpec = React.useMemo(() => {
    if (!spec || !state) return null;
    const resolved = resolvePanel(state, spec);
    return {
      ...spec,
      controls: spec.controls.filter((control) =>
        controlShown(control, resolved),
      ),
    };
  }, [spec, state]);
  // An image a shown `imagePick` control picked shows that control's label.
  const imageTags = React.useMemo(() => {
    const tags = new Map<string, string>();
    if (!spec || !state) return tags;
    const resolved = resolvePanel(state, spec);
    for (const control of spec.controls) {
      if (control.kind !== "imagePick" || !controlShown(control, resolved)) {
        continue;
      }
      const picked = images[Number(resolved.values[control.id]) - 1];
      if (picked) tags.set(picked.url, control.label);
    }
    return tags;
  }, [images, spec, state]);
  // The addressed agent is never a handle, even typed out rather than picked.
  const agentName = active?.agent.name;
  const handleSkipNames = React.useMemo(
    () => (agentName ? [...mentionNames, agentName] : mentionNames),
    [agentName, mentionNames],
  );
  const handles = useHarnessHandles({
    editor,
    harnessId,
    images: imageRefsOn ? images : [],
    mentionNames: handleSkipNames,
    spec: visible ? shownSpec : null,
    text,
  });

  const insertImage = (url: string) => {
    if (!editor || editor.isDestroyed) return;
    const at = images.findIndex((image) => image.url === url);
    if (at === -1) return;
    const { $from } = editor.state.selection;
    const before = $from.parent.textBetween(
      Math.max(0, $from.parentOffset - 1),
      $from.parentOffset,
      undefined,
      "\ufffc",
    );
    const lead =
      before && !/\s/.test(before) ? [{ type: "text", text: " " }] : [];
    editor
      .chain()
      .focus()
      .insertContent([...lead, ...imageRefContent(images, at)])
      .run();
  };

  return {
    modeToggle:
      visible && spec && state ? (
        <ComposerHarnessModeToggle
          onChange={setState}
          spec={spec}
          state={state}
        />
      ) : null,
    controls:
      visible && spec && state ? (
        <ComposerHarnessControls
          error={error}
          onChange={setState}
          onControlOpen={(controlId) => void handles.refreshControl(controlId)}
          onInsertHandle={handles.insertHandle}
          onMenuOpen={() => void refetchComposers()}
          refreshingId={handles.refreshingId}
          repositories={repositories}
          spec={spec}
          state={state}
        />
      ) : null,
    /** The `@` autocomplete, above the prompt. */
    promptExtras: handles.autocomplete,
    /** Tiles for the prompt's `@handles`, beside the attachment thumbnails. */
    handleTiles: handles.tiles,
    /** The picked role of an attached image (a video's first frame), by URL. */
    imageTag: (url: string): string | undefined => imageTags.get(url),
    /** Inserts an attached image's reference; null when the model takes none. */
    insertImage: imageRefsOn ? insertImage : null,
    /** False (with the reason shown in the panel) when the request can't go. */
    checkSend: () => {
      if (!spec || !state) return true;
      const reason = sendBlockReason(state, spec);
      setError(reason);
      return reason === null;
    },
    sendTags: (): string[][] =>
      spec && state && harnessId
        ? [composerTag(harnessId, composerPayload(state, spec))]
        : [],
    /**
     * Saves the request as the channel's last one the moment it's sent, so the
     * next mention restores it even while earlier generations are still
     * running. The draft's own picks are dropped so that restore reads it.
     */
    rememberRequest: () => {
      if (!state || !harnessId || !active) return;
      saveComposerMemory(
        channelId,
        harnessId,
        toSavedState(state, promptTextFor(text, active.agent.name)),
      );
      if (panelKey) {
        statesRef.current.delete(panelKey);
        editKeysRef.current.delete(panelKey);
      }
    },
  };
}
