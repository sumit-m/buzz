import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, Globe, Pencil } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { cn } from "@/shared/lib/cn";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import type { ImageSidecar } from "./imageSidecar";

/**
 * An image's prompt (with Copy Prompt, Edit where the caller supports it, and
 * a globe opening the generator's link to the image) and labelled fields from
 * its sidecar.
 */
export function ImageInfoSidebar({
  onEdit,
  sidecar,
}: {
  onEdit?: (button: HTMLElement) => void;
  sidecar: ImageSidecar;
}) {
  const { prompt } = sidecar;
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
      className="w-full shrink-0 space-y-4 lg:w-[350px]"
      data-testid="project-repository-image-info"
    >
      {prompt ? (
        <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
          <CollapsiblePrompt prompt={prompt} />
          <div className="flex flex-wrap gap-2">
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
function CollapsiblePrompt({ prompt }: { prompt: string }) {
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
        {prompt}
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
