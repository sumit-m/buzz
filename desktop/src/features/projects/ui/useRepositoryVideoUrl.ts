import { useQuery } from "@tanstack/react-query";

import type { ProjectRepoFile } from "@/features/projects/hooks";
import { videoMimeForPath } from "./repositoryVideo";
import type { RepositoryFileContentSource } from "./useRepositoryFileContent";

/**
 * LOCAL DIVERGENCE: a byte-range URL for a repository video, so the player
 * streams it, or `isVideo: false` for any other file (or a source without
 * one), so callers keep their other views.
 */
export function useRepositoryVideoUrl(
  file: ProjectRepoFile | null,
  source?: RepositoryFileContentSource,
) {
  const mediaUrl = source?.mediaUrl;
  const isVideo = Boolean(file && videoMimeForPath(file.path) && mediaUrl);
  const query = useQuery({
    enabled: isVideo,
    queryKey: [
      "project-repository-media-url",
      ...(source?.cacheKey ?? []),
      file?.path ?? "none",
    ],
    queryFn: () => (file && mediaUrl ? mediaUrl(file.path) : null),
    staleTime: 60_000,
    retry: 1,
  });
  return {
    isVideo,
    isLoading: isVideo && query.isLoading,
    url: query.data ?? null,
  };
}
