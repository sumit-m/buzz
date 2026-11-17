import type { Repository } from "@/features/projects/projectModels";
import { useQuery } from "@tanstack/react-query";

import type { ProjectRepoFile } from "@/features/projects/hooks";
import type { ProjectRepoThumbnail } from "@/shared/api/projectGit";

export type RepositoryFileContentSource = {
  cacheKey: readonly unknown[];
  load: (path: string) => Promise<string | null>;
  /** Raw bytes, for files the text preview cannot show (images). */
  loadBytes?: (path: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  /** Thumbnails for the tiles view, read from one checkout. */
  loadThumbnails?: (paths: string[]) => Promise<ProjectRepoThumbnail[]>;
  /** The repository these files are from, for actions that reach its channel. */
  repository?: Repository;
};

export function useRepositoryFileContent(
  file: ProjectRepoFile | null,
  source?: RepositoryFileContentSource,
) {
  const shouldLoad = Boolean(file && file.previewContent === null && source);
  const query = useQuery({
    enabled: shouldLoad,
    queryKey: [
      "project-repository-file-content",
      ...(source?.cacheKey ?? []),
      file?.path ?? "none",
    ],
    queryFn: () => {
      if (!file || !source) return null;
      return source.load(file.path);
    },
    staleTime: 30_000,
    retry: 1,
  });

  return {
    content: file?.previewContent ?? query.data ?? null,
    error: query.error,
    isLoading: shouldLoad && query.isLoading,
  };
}
