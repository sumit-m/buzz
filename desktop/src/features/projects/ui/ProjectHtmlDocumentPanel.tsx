import { Maximize2, X } from "lucide-react";
import * as React from "react";

import { RightAuxiliaryPane } from "@/features/channels/ui/RightAuxiliaryPane";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  closeHtmlDocument,
  type HtmlDocument,
} from "@/shared/ui/markdown/htmlDocumentPanel";
import {
  HtmlReportDialog,
  HtmlReportDownloadButton,
  HtmlReportFrame,
} from "@/shared/ui/markdown/HtmlReportDialog";

/** The project page's right panel, showing an open HTML document. */
export function ProjectHtmlDocumentPanel({
  canResetWidth,
  detached,
  doc,
  onResetWidth,
  onResizeStart,
  widthPx,
}: {
  canResetWidth: boolean;
  detached: boolean;
  doc: HtmlDocument;
  onResetWidth: () => void;
  onResizeStart: React.ComponentProps<
    typeof RightAuxiliaryPane
  >["onResizeStart"];
  widthPx: number;
}) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <RightAuxiliaryPane
      canResetWidth={canResetWidth}
      constrainToAvailableSpace={!detached}
      detached={detached}
      onResetWidth={onResetWidth}
      onResizeStart={onResizeStart}
      testId="project-html-document-panel"
      widthPx={widthPx}
    >
      <div
        className={cn(
          "relative z-30 flex min-h-0 flex-1 flex-col",
          !detached && "p-3",
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl",
            detached ? "bg-background" : "border border-border/60 bg-muted/30",
          )}
        >
          <div className="flex min-w-0 items-center gap-1 py-2 pr-2 pl-4">
            <h2 className="min-w-0 flex-1 truncate text-sm font-normal text-muted-foreground/70">
              {doc.filename}
            </h2>
            <HtmlReportDownloadButton doc={doc} />
            <Button
              aria-label="Open larger"
              className="h-7 w-7 shrink-0"
              onClick={() => setExpanded(true)}
              size="icon"
              title="Open larger"
              type="button"
              variant="ghost"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button
              aria-label="Close"
              className="h-7 w-7 shrink-0"
              onClick={closeHtmlDocument}
              size="icon"
              title="Close"
              type="button"
              variant="ghost"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <HtmlReportFrame
            className="border-border/60 border-t"
            doc={doc}
            key={doc.loadKey}
          />
        </div>
      </div>
      {expanded ? (
        <HtmlReportDialog doc={doc} onClose={() => setExpanded(false)} />
      ) : null}
    </RightAuxiliaryPane>
  );
}
