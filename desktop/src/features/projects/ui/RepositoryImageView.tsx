import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { normalizeFolder } from "@/features/messages/lib/composerFolderSuggestions";
import {
  openProjectChat,
  PROJECT_CHAT_DRAFT_KEY_PREFIX,
  requestHarnessEdit,
} from "@/features/messages/lib/harnessEditRequest";
import { useHarnessEditAvailable } from "@/features/messages/ui/useHarnessEditAvailable";
import type { ProjectRepoFile } from "@/features/projects/hooks";
import { ImageInfoSidebar } from "./ImageInfoSidebar";
import { parseImageSidecar, sidecarPathFor } from "./imageSidecar";
import {
  type RepositoryFileContentSource,
  useRepositoryFileContent,
} from "./useRepositoryFileContent";

/**
 * A repository image at full size, with an info sidebar when the folder holds
 * its `.json` sidecar. LOCAL DIVERGENCE: the sidebar's Edit starts an edit
 * request for the image in the project's agent chat (a DM with the agent), or
 * the repository's channel where the screen has no chat, saving back to the
 * image's folder.
 */
export function RepositoryImageView({
  file,
  fileContentSource,
  files,
  url,
}: {
  file: ProjectRepoFile;
  fileContentSource?: RepositoryFileContentSource;
  files: ProjectRepoFile[];
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
  const { goChannel } = useAppNavigation();
  const canEdit = useHarnessEditAvailable();
  const repository = fileContentSource?.repository;
  const channelId = repository?.channelId ?? null;
  const onEdit =
    canEdit && repository && sidecar
      ? async () => {
          let image: File;
          try {
            const blob = await (await fetch(url)).blob();
            image = new File([blob], name, {
              type: blob.type || "image/jpeg",
            });
          } catch {
            toast.error("Could not read this image");
            return;
          }
          const folder = normalizeFolder(
            file.path.slice(0, file.path.lastIndexOf("/") + 1),
          );
          const inProjectChat = openProjectChat();
          if (!inProjectChat && !channelId) {
            toast.error("Open the project's agent chat to edit this image");
            return;
          }
          requestHarnessEdit({
            authorPubkey: null,
            draftKey: inProjectChat
              ? PROJECT_CHAT_DRAFT_KEY_PREFIX
              : (channelId ?? ""),
            image,
            prompt: sidecar.prompt,
            repo: `${repository.owner}/${repository.dtag}:${folder}`,
            repository,
            values: sidecar.values,
          });
          if (!inProjectChat && channelId) void goChannel(channelId);
        }
      : undefined;

  return (
    <div className="flex flex-col gap-4 bg-background/60 p-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 justify-center">
        <img
          alt={name}
          className="max-h-[75vh] max-w-full rounded-md object-contain"
          data-testid="project-repository-image-preview"
          src={url}
        />
      </div>
      {sidecar ? <ImageInfoSidebar onEdit={onEdit} sidecar={sidecar} /> : null}
    </div>
  );
}
