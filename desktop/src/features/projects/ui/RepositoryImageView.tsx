import { Copy } from "lucide-react";

import type { ProjectRepoFile } from "@/features/projects/hooks";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import {
  type ImageSidecar,
  parseImageSidecar,
  sidecarPathFor,
} from "./imageSidecar";
import {
  type RepositoryFileContentSource,
  useRepositoryFileContent,
} from "./useRepositoryFileContent";

function ImageInfoSidebar({ sidecar }: { sidecar: ImageSidecar }) {
  const { prompt } = sidecar;
  return (
    <aside
      className="w-full shrink-0 space-y-4 lg:w-[350px]"
      data-testid="project-repository-image-info"
    >
      {prompt ? (
        <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
            {prompt}
          </p>
          <Button
            onClick={() => copyTextToClipboard(prompt, "Prompt copied")}
            size="sm"
            type="button"
            variant="outline"
          >
            <Copy />
            Copy Prompt
          </Button>
        </div>
      ) : null}
      {sidecar.fields.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-1">
          {sidecar.fields.map((field) => (
            <div className="min-w-0" key={field.label}>
              <dt className="text-xs text-muted-foreground">{field.label}</dt>
              <dd
                className="break-words text-sm font-medium text-foreground"
                title={field.value}
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </aside>
  );
}

/**
 * A repository image at full size, with an info sidebar when the folder holds
 * its `.json` sidecar.
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
      {sidecar ? <ImageInfoSidebar sidecar={sidecar} /> : null}
    </div>
  );
}
