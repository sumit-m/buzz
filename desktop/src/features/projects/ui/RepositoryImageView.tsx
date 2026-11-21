import { toast } from "sonner";

import { normalizeFolder } from "@/features/messages/lib/composerFolderSuggestions";
import {
  openProjectChat,
  PROJECT_CHAT_DRAFT_KEY_PREFIX,
  requestHarnessEdit,
} from "@/features/messages/lib/harnessEditRequest";
import { useHarnessEditAvailable } from "@/features/messages/ui/useHarnessEditAvailable";
import type { ProjectRepoFile } from "@/features/projects/hooks";
import { VideoPlayer } from "@/shared/ui/VideoPlayer";
import { ImageInfoSidebar } from "./ImageInfoSidebar";
import { parseImageSidecar, sidecarPathFor } from "./imageSidecar";
import {
  type RepositoryFileContentSource,
  useRepositoryFileContent,
} from "./useRepositoryFileContent";

/**
 * A repository image at full size, or a video in Buzz's player, with an info
 * sidebar when the folder holds its `.json` sidecar. LOCAL DIVERGENCE: the
 * sidebar's Edit starts an edit request for the file in the project's agent
 * chat (a DM with the agent), saving back to the file's folder.
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
  const canEdit = useHarnessEditAvailable();
  const repository = fileContentSource?.repository;
  const onEdit =
    canEdit && repository && sidecar
      ? async () => {
          let image: File;
          try {
            const blob = await (await fetch(url)).blob();
            image = new File([blob], name, {
              type: blob.type || (isVideo ? "video/mp4" : "image/jpeg"),
            });
          } catch {
            toast.error(`Could not read this ${isVideo ? "video" : "image"}`);
            return;
          }
          const folder = normalizeFolder(
            file.path.slice(0, file.path.lastIndexOf("/") + 1),
          );
          if (!openProjectChat()) {
            toast.error(
              `Open the project's agent chat to edit this ${isVideo ? "video" : "image"}`,
            );
            return;
          }
          requestHarnessEdit({
            authorPubkey: null,
            draftKey: PROJECT_CHAT_DRAFT_KEY_PREFIX,
            image,
            prompt: sidecar.prompt,
            repo: `${repository.owner}/${repository.dtag}:${folder}`,
            repository,
            values: sidecar.values,
          });
        }
      : undefined;

  return (
    <div className="flex flex-col gap-4 bg-background/60 p-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 justify-center">
        {isVideo ? (
          <div
            className="w-full max-w-3xl"
            data-testid="project-repository-video-preview"
          >
            <VideoPlayer
              aspectRatio={videoAspect(sidecar?.values)}
              filename={name}
              src={url}
            />
          </div>
        ) : (
          <img
            alt={name}
            className="max-h-[75vh] max-w-full rounded-md object-contain"
            data-testid="project-repository-image-preview"
            src={url}
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
          onEdit={onEdit}
          sidecar={sidecar}
        />
      ) : null}
    </div>
  );
}

/** Width over height from a sidecar, for the player's frame before it loads. */
function videoAspect(values: Record<string, string> | undefined) {
  const width = Number(values?.width);
  const height = Number(values?.height);
  return width > 0 && height > 0 ? width / height : undefined;
}
