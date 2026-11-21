import type { ProjectRepoFile } from "@/features/projects/hooks";
import type { ProjectRepoThumbnail } from "@/shared/api/projectGit";
import { captureFirstFrame, videoMimeForPath } from "./repositoryVideo";
import { imageMimeForPath } from "./useRepositoryImagePreview";
import type { RepositoryFileContentSource } from "./useRepositoryFileContent";

/**
 * Thumbnails are cached one per image, keyed by the commit that last changed
 * it, so a push only costs thumbnails for the images it added or changed.
 * Requests made in the same tick go to the checkout as one load.
 */
const BATCH_LIMIT = 300;
const THUMBNAIL_CACHE_MS = 60 * 60_000;

type Versioned = {
  path: string;
  latestCommit: ProjectRepoFile["latestCommit"];
  lastChangedAt?: number | null;
};
type Load = (paths: string[]) => Promise<ProjectRepoThumbnail[]>;
type Request = {
  path: string;
  resolve: (thumbnail: ProjectRepoThumbnail | null) => void;
  reject: (error: unknown) => void;
};

const queues = new Map<string, { load: Load; requests: Request[] }>();
let flushScheduled = false;

function loadChunk(load: Load, requests: Request[]) {
  const paths = [...new Set(requests.map((request) => request.path))];
  load(paths).then(
    (thumbnails) => {
      const byPath = new Map(thumbnails.map((thumb) => [thumb.path, thumb]));
      for (const request of requests) {
        request.resolve(byPath.get(request.path) ?? null);
      }
    },
    (error) => {
      for (const request of requests) request.reject(error);
    },
  );
}

function flush() {
  flushScheduled = false;
  const pending = [...queues.values()];
  queues.clear();
  for (const { load, requests } of pending) {
    for (let start = 0; start < requests.length; start += BATCH_LIMIT) {
      loadChunk(load, requests.slice(start, start + BATCH_LIMIT));
    }
  }
}

export function requestThumbnail(
  sourceKey: string,
  load: Load,
  path: string,
): Promise<ProjectRepoThumbnail | null> {
  return new Promise((resolve, reject) => {
    const queue = queues.get(sourceKey) ?? { load, requests: [] };
    queue.load = load;
    queue.requests.push({ path, resolve, reject });
    queues.set(sourceKey, queue);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flush, 0);
    }
  });
}

export function thumbnailVersion(file: Versioned) {
  return file.latestCommit?.hash ?? file.lastChangedAt ?? "unversioned";
}

export function thumbnailQuery(
  source: RepositoryFileContentSource | undefined,
  file: Versioned,
) {
  const cacheKey = source?.cacheKey ?? [];
  const load = source?.loadThumbnails;
  const mediaUrl = source?.mediaUrl;
  const isVideo = videoMimeForPath(file.path) !== null;
  return {
    enabled: Boolean(isVideo ? mediaUrl : load),
    queryKey: [
      "project-repository-thumbnail",
      ...cacheKey,
      file.path,
      thumbnailVersion(file),
    ],
    queryFn: async () => {
      if (isVideo) {
        const url = mediaUrl ? await mediaUrl(file.path) : null;
        return url ? captureFirstFrame(file.path, url) : null;
      }
      return load
        ? requestThumbnail(JSON.stringify(cacheKey), load, file.path)
        : null;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: THUMBNAIL_CACHE_MS,
    retry: 1,
  };
}

/** Images the new list added, or changed since the previous one. */
export function changedImages(
  previous: ProjectRepoFile[],
  next: ProjectRepoFile[],
) {
  const before = new Map(
    previous.map((file) => [file.path, thumbnailVersion(file)]),
  );
  return next.filter(
    (file) =>
      (imageMimeForPath(file.path) !== null ||
        videoMimeForPath(file.path) !== null) &&
      before.get(file.path) !== thumbnailVersion(file),
  );
}
