import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import type { ProjectRepoFile } from "@/features/projects/hooks";
import type { RepositoryFileContentSource } from "./useRepositoryFileContent";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export function imageMimeForPath(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return path.includes(".")
    ? (IMAGE_MIME_BY_EXTENSION[extension] ?? null)
    : null;
}

/**
 * An object URL for a repository image, or `isImage: false` for any other
 * file (or a source that cannot load bytes), so callers keep their text view.
 */
export function useRepositoryImagePreview(
  file: ProjectRepoFile | null,
  source?: RepositoryFileContentSource,
) {
  const mime = file ? imageMimeForPath(file.path) : null;
  const loadBytes = source?.loadBytes;
  const isImage = Boolean(mime && loadBytes);
  const query = useQuery({
    enabled: isImage,
    queryKey: [
      "project-repository-file-bytes",
      ...(source?.cacheKey ?? []),
      file?.path ?? "none",
    ],
    queryFn: () => (file && loadBytes ? loadBytes(file.path) : null),
    staleTime: 30_000,
    retry: 1,
  });

  const bytes = query.data ?? null;
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!bytes || !mime) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, mime]);

  return {
    isImage,
    isLoading: isImage && query.isLoading,
    url,
  };
}
