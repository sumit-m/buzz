/**
 * LOCAL DIVERGENCE: a generated image's repo location and the requests the
 * image info sidebar makes from it (Regenerate, move or copy). Pure — no
 * React, no Tauri.
 */

import type { ImetaMedia } from "@/features/messages/lib/imetaMediaMarkdown";
import { buildOutgoingMessage } from "@/features/messages/lib/imetaMediaMarkdown";
import type { Repository } from "@/features/projects/projectModels";
import { VIDEO_MODE } from "@/features/messages/lib/composerHarnessState";
import {
  type ImageOrigin,
  isVideoOrigin,
  type SidecarSource,
  sidecarPathFor,
} from "@/features/projects/ui/imageSidecar";

export type ImageLocation = {
  repository: Repository;
  imagePath: string;
  /** The `.json` beside the image, when the repo has it. */
  sidecarPath: string | null;
};

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `assets/foxes/` for `assets/foxes/h1.jpg`; `""` at the root. */
export function folderOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

export function folderLabel(folder: string): string {
  return folder || "/";
}

/** `<owner>/<repo>:<folder>` (or the older `<repo>:<folder>`). */
export function parseRepoValue(
  value: string,
): { owner: string | null; dtag: string; folder: string } | null {
  const colon = value.indexOf(":");
  if (colon < 1) return null;
  const qualified = value.slice(0, colon);
  const slash = qualified.indexOf("/");
  const owner = slash < 0 ? null : qualified.slice(0, slash);
  const dtag = slash < 0 ? qualified : qualified.slice(slash + 1);
  const folder = value
    .slice(colon + 1)
    .replace(/^\/+/, "")
    .replace(/\/*$/, "");
  return dtag ? { owner, dtag, folder: folder ? `${folder}/` : "" } : null;
}

/** The repository an `<owner>/<repo>` (or bare `<repo>`) names. */
export function findRepository(
  repositories: readonly Repository[],
  address: string | null,
): Repository | null {
  if (!address) return null;
  const parsed = parseRepoValue(`${address}:`);
  if (!parsed) return null;
  return (
    repositories.find(
      (repository) =>
        repository.dtag === parsed.dtag &&
        (parsed.owner === null ||
          repository.owner.toLowerCase() === parsed.owner.toLowerCase()),
    ) ?? null
  );
}

/**
 * Where to look for the image and offer to move it: the repo being viewed,
 * the repo it was saved to, then the channel's repos.
 */
export function candidateRepositories(
  all: readonly Repository[],
  {
    channelId,
    current,
    originRepo,
  }: {
    channelId: string | null;
    current: Repository | null;
    originRepo: string | null;
  },
): Repository[] {
  const ordered = [
    current,
    findRepository(all, originRepo),
    ...all.filter((repository) =>
      Boolean(channelId && repository.channelId === channelId),
    ),
  ];
  const seen = new Set<string>();
  return ordered.filter((repository): repository is Repository => {
    if (!repository || seen.has(repository.id)) return false;
    seen.add(repository.id);
    return true;
  });
}

/**
 * The image among the paths named like it (`preferPath` first, as the copy
 * being viewed), with its sidecar when that sits beside it.
 */
export function locationFromMatches(
  repository: Repository,
  matches: readonly string[],
  imageName: string,
  preferPath: string | null = null,
): ImageLocation | null {
  const images = matches.filter((path) => fileName(path) === imageName);
  const imagePath =
    preferPath && images.includes(preferPath) ? preferPath : images[0];
  if (!imagePath) return null;
  const sidecarPath = sidecarPathFor(imagePath);
  return {
    repository,
    imagePath,
    sidecarPath: matches.includes(sidecarPath) ? sidecarPath : null,
  };
}

export type CommitAdd =
  | { path: string; url: string }
  | { path: string; from: { repository: Repository; path: string } };

export type CommitPlan = {
  repository: Repository;
  renames: { from: string; to: string }[];
  adds: CommitAdd[];
  deletes: string[];
  message: string;
};

export type Relocation = {
  commits: CommitPlan[];
  destination: { repository: Repository; imagePath: string };
};

/**
 * The commits that put the image (and its sidecar) in `folder` of `target`:
 * a rename within one repo, a copy then a removal across repos, or, for a
 * chat image not saved anywhere, a copy of its attachments. `null` when it's
 * already there, or there's nothing to copy from.
 */
export function planRelocation({
  attachments,
  folder,
  imageName,
  location,
  target,
}: {
  /** The chat message's image and sidecar uploads. */
  attachments: { imageUrl: string; sidecarUrl: string | null } | null;
  folder: string;
  imageName: string;
  location: ImageLocation | null;
  target: Repository;
}): Relocation | null {
  const imagePath = `${folder}${imageName}`;
  const sidecarPath = sidecarPathFor(imagePath);
  const destination = { repository: target, imagePath };
  const where = `${target.name}: ${folderLabel(folder)}`;
  if (!location) {
    if (!attachments) return null;
    const adds: CommitAdd[] = [{ path: imagePath, url: attachments.imageUrl }];
    if (attachments.sidecarUrl) {
      adds.push({ path: sidecarPath, url: attachments.sidecarUrl });
    }
    return {
      commits: [
        {
          repository: target,
          renames: [],
          adds,
          deletes: [],
          message: `Add ${imageName} to ${folderLabel(folder)}`,
        },
      ],
      destination,
    };
  }
  const pairs: [string, string][] = [[location.imagePath, imagePath]];
  if (location.sidecarPath) pairs.push([location.sidecarPath, sidecarPath]);
  if (location.repository.id === target.id) {
    if (location.imagePath === imagePath) return null;
    return {
      commits: [
        {
          repository: target,
          renames: pairs.map(([from, to]) => ({ from, to })),
          adds: [],
          deletes: [],
          message: `Move ${imageName} to ${folderLabel(folder)}`,
        },
      ],
      destination,
    };
  }
  return {
    commits: [
      {
        repository: target,
        renames: [],
        adds: pairs.map(([from, to]) => ({
          path: to,
          from: { repository: location.repository, path: from },
        })),
        deletes: [],
        message: `Add ${imageName} from ${location.repository.name}`,
      },
      {
        repository: location.repository,
        renames: [],
        adds: [],
        deletes: pairs.map(([from]) => from),
        message: `Move ${imageName} to ${where}`,
      },
    ],
    destination,
  };
}

/** Whether the sidecar says enough to make the same request again. */
export function canRegenerate(origin: ImageOrigin | null): boolean {
  if (!origin) return false;
  if (origin.sources.length > 0) return origin.sources.every((s) => s.x);
  return origin.mode === "generate" || origin.mode === "video";
}

export function imetaFromSource(source: SidecarSource): ImetaMedia {
  return {
    url: source.url,
    type: source.m ?? "image/jpeg",
    sha256: source.x ?? "",
    size: Number(source.size) || 0,
    uploaded: 0,
    ...(source.dim ? { dim: source.dim } : {}),
  };
}

/** `<owner>/<repo>:<folder>` for the panel's repo control. */
export function repoValueFor(location: ImageLocation): string {
  const { repository, imagePath } = location;
  return `${repository.owner}/${repository.dtag}:${folderOf(imagePath)}`;
}

/**
 * The panel Regenerate rebuilds from an origin: how many images and videos
 * its sources attach, and for a video the mode and the picks the sidecar
 * keeps in its origin (first frame; Extend or Edit).
 */
export function regenerateSetup(origin: ImageOrigin): {
  images: number;
  options: {
    mode?: string;
    picks: Record<string, string>;
    videos: number;
  };
} {
  const videos = origin.sources.filter((s) => s.m?.startsWith("video/")).length;
  const images = origin.sources.length - videos;
  if (!isVideoOrigin(origin)) return { images, options: { picks: {}, videos } };
  const picks: Record<string, string> = {};
  if (origin.frame) picks.frame = origin.frame;
  if (origin.mode === "video-extend") picks.action = "extend";
  if (origin.mode === "video-edit") picks.action = "edit";
  return { images, options: { mode: VIDEO_MODE, picks, videos } };
}

/** The message Regenerate posts: the mention and prompt, plus every source in order. */
export function regenerateMessage({
  agentName,
  prompt,
  sources,
}: {
  agentName: string;
  prompt: string;
  sources: readonly SidecarSource[];
}) {
  return buildOutgoingMessage(
    `@${agentName} ${prompt.replace(/\s+/g, " ").trim()}`,
    sources.map(imetaFromSource),
  );
}
