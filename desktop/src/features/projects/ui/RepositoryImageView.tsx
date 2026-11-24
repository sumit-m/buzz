import * as React from "react";

import type { ProjectRepoFile } from "@/features/projects/hooks";
import { VideoPlayer } from "@/shared/ui/VideoPlayer";
import { ImageInfoSidebar } from "./ImageInfoSidebar";
import { parseImageSidecar, sidecarPathFor } from "./imageSidecar";
import {
  type RepositoryFileContentSource,
  useRepositoryFileContent,
} from "./useRepositoryFileContent";

type Box = { height: number; width: number };

/** Below the media, matching the view's `p-4`. */
const BOTTOM_PADDING_PX = 16;

/**
 * A repository image or video as wide as the free space, or as tall as the
 * visible pane when that is smaller, with an info sidebar when the folder
 * holds its `.json` sidecar. LOCAL DIVERGENCE: the sidebar's Edit and
 * Regenerate use the project's agent chat (a DM with the agent), saving back
 * to the file's folder.
 */
export function RepositoryImageView({
  file,
  fileContentSource,
  files,
  isVideo = false,
  onOpenPath,
  url,
}: {
  file: ProjectRepoFile;
  fileContentSource?: RepositoryFileContentSource;
  files: ProjectRepoFile[];
  /** `url` streams a video rather than holding an image. */
  isVideo?: boolean;
  /** Follows the file after the sidebar moves it. */
  onOpenPath?: (path: string) => void;
  url: string;
}) {
  const sidecarPath = sidecarPathFor(file.path);
  const sidecarFile =
    files.find((candidate) => candidate.path === sidecarPath) ?? null;
  const sidecarContent = useRepositoryFileContent(
    sidecarFile,
    fileContentSource,
  );
  const sidecar = sidecarContent.content
    ? parseImageSidecar(sidecarContent.content)
    : null;
  const name = file.path.split("/").pop() ?? file.path;
  const repository = fileContentSource?.repository;
  const mediaRef = React.useRef<HTMLDivElement>(null);
  const box = useVisibleBox(mediaRef);
  const [loaded, setLoaded] = React.useState<{
    aspect: number;
    url: string;
  } | null>(null);
  const imageAspect = loaded?.url === url ? loaded.aspect : null;

  return (
    <div className="flex flex-col gap-4 bg-background/60 p-4 lg:flex-row lg:items-start">
      <div ref={mediaRef} className="flex min-w-0 flex-1 justify-center">
        {isVideo ? (
          <div data-testid="project-repository-video-preview">
            {box ? (
              <VideoPlayer
                aspectRatio={videoAspect(sidecar?.values)}
                filename={name}
                fitBox={box}
                src={url}
              />
            ) : null}
          </div>
        ) : (
          <img
            alt={name}
            className="max-w-full rounded-md"
            data-testid="project-repository-image-preview"
            onLoad={(event) => {
              const { naturalHeight, naturalWidth } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) {
                setLoaded({ aspect: naturalWidth / naturalHeight, url });
              }
            }}
            src={url}
            style={
              box && imageAspect
                ? {
                    width: Math.round(
                      Math.min(box.width, box.height * imageAspect),
                    ),
                  }
                : { visibility: "hidden" }
            }
          />
        )}
      </div>
      {sidecar ? (
        <ImageInfoSidebar
          context={
            repository
              ? { kind: "repo", repository, path: file.path, onOpenPath }
              : undefined
          }
          sidecar={sidecar}
        />
      ) : null}
    </div>
  );
}

/**
 * The element's width, and the height from its top (when scrolled to the
 * top) to the bottom of the pane that scrolls it.
 */
function useVisibleBox(ref: React.RefObject<HTMLElement | null>) {
  const [box, setBox] = React.useState<Box | null>(null);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const pane = scrollParent(element);
    const measure = () => {
      const top =
        element.getBoundingClientRect().top -
        pane.getBoundingClientRect().top +
        pane.scrollTop;
      const width = Math.floor(element.clientWidth);
      const height = Math.max(
        160,
        Math.floor(pane.clientHeight - top - BOTTOM_PADDING_PX),
      );
      setBox((current) =>
        current?.width === width && current.height === height
          ? current
          : { height, width },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [ref]);

  return box;
}

function scrollParent(element: HTMLElement): HTMLElement {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  }
  return document.documentElement;
}

/** Width over height from a sidecar, for the player's frame before it loads. */
function videoAspect(values: Record<string, string> | undefined) {
  const width = Number(values?.width);
  const height = Number(values?.height);
  return width > 0 && height > 0 ? width / height : undefined;
}
