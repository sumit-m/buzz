import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Copy,
  GitBranch,
  Globe,
  LoaderCircle,
  Pencil,
  RotateCw,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  type AssetIndex,
  imageEntries,
  withEntries,
} from "@/features/messages/lib/promptHandles";
import {
  HighlightedHandles,
  PromptAssets,
  useHarnessAssetIndex,
} from "@/features/messages/ui/HarnessAssets";
import { ComposerRepoFolderPopup } from "@/features/messages/ui/ComposerRepoFolderPopup";
import { folderLabel } from "@/features/projects/lib/generatedImage";
import { cn } from "@/shared/lib/cn";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type { ImageSidecar } from "./imageSidecar";
import {
  type GeneratedImageContext,
  useGeneratedImageActions,
} from "./useGeneratedImageActions";

/**
 * An image's prompt (with Copy Prompt, Edit where the caller supports it, and
 * a globe opening the generator's link to the image) and labelled fields from
 * its sidecar. Characters and references the prompt names (`@handle`) show
 * above it while a harness lists assets. With a `context`, it also offers
 * Regenerate and the repo button (where the image is saved; picking another
 * folder moves or copies it), and an edit shows the image it started from.
 */
export function ImageInfoSidebar({
  context,
  onEdit,
  sidecar,
}: {
  context?: GeneratedImageContext;
  onEdit?: (button: HTMLElement) => void;
  sidecar: ImageSidecar;
}) {
  const { prompt } = sidecar;
  const assets = useHarnessAssetIndex();
  const rootRef = React.useRef<HTMLElement>(null);
  const actions = useGeneratedImageActions({ context, rootRef, sidecar });
  const sources = sidecar.origin?.sources ?? [];
  // `@image1…` in the prompt name the sources, so they're known handles here.
  const handles = React.useMemo(
    () =>
      withEntries(
        assets,
        imageEntries(
          sources.map((source) => rewriteRelayUrl(source.url)),
          "source",
        ),
      ),
    [assets, sources],
  );
  const parsedExpiry = sidecar.values.expires_at
    ? new Date(sidecar.values.expires_at)
    : null;
  const expires =
    parsedExpiry && !Number.isNaN(parsedExpiry.getTime()) ? parsedExpiry : null;
  const link =
    expires && expires.getTime() <= Date.now()
      ? null
      : webLink(sidecar.values.result_url);
  const linkTitle = expires
    ? `Open in browser (link expires ${expires.toLocaleDateString(undefined, { dateStyle: "medium" })})`
    : "Open in browser";
  return (
    <aside
      className="w-full shrink-0 space-y-4 lg:w-[400px]"
      data-testid="project-repository-image-info"
      ref={rootRef}
    >
      {prompt ? (
        <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
          {handles.size > 0 ? (
            <PromptAssets index={handles} prompt={prompt} />
          ) : null}
          <CollapsiblePrompt assets={handles} prompt={prompt} />
          <div className="flex flex-wrap gap-1">
            <Button
              onClick={() => copyTextToClipboard(prompt, "Prompt copied")}
              size="sm"
              type="button"
              variant="outline"
            >
              <Copy />
              Copy Prompt
            </Button>
            {onEdit ? (
              <Button
                data-testid="image-info-edit"
                onClick={(event) => onEdit(event.currentTarget)}
                size="sm"
                type="button"
                variant="outline"
              >
                <Pencil />
                Edit
              </Button>
            ) : null}
            {actions.regenerate ? (
              <Button
                aria-label="Regenerate"
                data-testid="image-info-regenerate"
                disabled={
                  actions.regenerate.blocked !== null ||
                  actions.regenerate.regenerating
                }
                onClick={() => void actions.regenerate?.run()}
                size="icon"
                title={actions.regenerate.blocked ?? undefined}
                type="button"
                variant="outline"
              >
                {actions.regenerate.regenerating ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RotateCw />
                )}
              </Button>
            ) : null}
            {context && actions.repositories.length > 0 ? (
              <ImageRepoButton actions={actions} />
            ) : null}
            {link ? (
              <Button
                aria-label={linkTitle}
                className="ml-auto"
                data-testid="image-info-open-link"
                onClick={() =>
                  void openUrl(link).catch(() =>
                    toast.error("Failed to open link"),
                  )
                }
                size="icon"
                type="button"
                variant="outline"
              >
                <Globe />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {sidecar.fields.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-1">
          {sidecar.fields.map((field) => (
            <div className="min-w-0" key={field.label}>
              <dt className="text-sm text-muted-foreground/75">
                {field.label}
              </dt>
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
      {sources.length > 0 ? (
        <dl className="px-1">
          <dt className="text-sm text-muted-foreground/75">
            {sourcesLabel(sources, sidecar.origin?.frame ?? null)}
          </dt>
          <dd className="mt-1.5 flex flex-wrap gap-2">
            {sources.map((source, index) => {
              const className = cn(
                "rounded-md object-cover",
                sources.length === 1 ? "max-h-48 max-w-[168px]" : "h-20 w-20",
              );
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list that may repeat an upload
                <figure className="space-y-1" key={index}>
                  {source.m?.startsWith("video/") ? (
                    <video
                      className={className}
                      data-testid="image-info-source"
                      muted
                      preload="metadata"
                      src={rewriteRelayUrl(source.url)}
                    />
                  ) : (
                    <img
                      alt={`Source ${index + 1}`}
                      className={className}
                      data-testid="image-info-source"
                      loading="lazy"
                      src={rewriteRelayUrl(source.url)}
                    />
                  )}
                  {sources.length > 1 ? (
                    <figcaption className="text-xs text-muted-foreground">
                      Image {index + 1}
                      {sidecar.origin?.frame === String(index + 1)
                        ? " · first frame"
                        : ""}
                    </figcaption>
                  ) : null}
                </figure>
              );
            })}
          </dd>
        </dl>
      ) : null}
    </aside>
  );
}

/** Where the image is saved (repo and folder); a pick moves or copies it. */
function ImageRepoButton({
  actions,
}: {
  actions: ReturnType<typeof useGeneratedImageActions>;
}) {
  const [open, setOpen] = React.useState(false);
  const { data, folder, isError, isLoading } = actions.location;
  const where = isLoading
    ? "Finding the image…"
    : isError
      ? "Couldn't look up the image"
      : data
        ? `${data.repository.name}: ${folderLabel(folder ?? "")}`
        : data === null
          ? "Not saved to a repository"
          : "";
  return (
    <Popover
      onOpenChange={(next) => {
        if (next) actions.requestLocation();
        setOpen(next);
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label="Repository location"
          data-testid="image-info-repo"
          disabled={actions.moving}
          size="icon"
          type="button"
          variant="outline"
        >
          {actions.moving ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <GitBranch />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-3" side="bottom">
        <p
          className="mb-2 max-w-64 truncate text-xs text-muted-foreground"
          data-testid="image-info-repo-location"
        >
          {where}
        </p>
        <ComposerRepoFolderPopup
          defaultFolder={folder ?? undefined}
          onPick={(value) => {
            setOpen(false);
            void actions.relocate(value);
          }}
          repositories={actions.repositories}
        />
      </PopoverContent>
    </Popover>
  );
}

/** "Video", "First frame", "Image" or "Images", for the sources heading. */
function sourcesLabel(
  sources: readonly { m?: string }[],
  frame: string | null,
): string {
  if (sources.every((source) => source.m?.startsWith("video/"))) {
    return "Video";
  }
  if (sources.length === 1) return frame === "1" ? "First frame" : "Image";
  return "Images";
}

function webLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** The prompt clamped to 5 lines, or expanded and scrolling past 15. */
function CollapsiblePrompt({
  assets,
  prompt,
}: {
  assets: AssetIndex;
  prompt: string;
}) {
  const textRef = React.useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [overflows, setOverflows] = React.useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the prompt changes
  React.useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || expanded) return undefined;
    text.scrollTop = 0;
    const measure = () =>
      setOverflows(text.scrollHeight > text.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [expanded, prompt]);

  return (
    <div className="space-y-2">
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground",
          expanded ? "max-h-[15lh] overflow-y-auto pr-2" : "line-clamp-5",
        )}
        data-testid="image-info-prompt"
        ref={textRef}
      >
        {assets.size > 0 ? (
          <HighlightedHandles index={assets} text={prompt} />
        ) : (
          prompt
        )}
      </p>
      {overflows ? (
        <button
          className="text-sm font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((open) => !open)}
          type="button"
        >
          {expanded ? "Hide" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
