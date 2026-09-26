import { Maximize2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as React from "react";

import { FocusThreadDrawer } from "@/features/channels/ui/FocusThreadDrawer";
import { IdleAuxiliaryPanel } from "@/features/channels/ui/IdleAuxiliaryPanel";
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

/**
 * An open HTML document over the project page, in the same focus drawer a
 * channel uses for its side panels. Render it inside the page's relative
 * layout root.
 */
export function ProjectHtmlDocumentDrawer({
  doc,
  projectName,
}: {
  doc: HtmlDocument | null;
  projectName: string;
}) {
  const [expanded, setExpanded] = React.useState(false);
  React.useEffect(() => {
    if (!doc) setExpanded(false);
  }, [doc]);

  return (
    <AnimatePresence>
      {doc ? (
        <FocusThreadDrawer
          channelName={projectName}
          key="project-html-document"
          label={doc.filename}
          onClose={closeHtmlDocument}
        >
          <IdleAuxiliaryPanel
            canResetWidth={false}
            headerControls={{
              actions: (
                <>
                  <HtmlReportDownloadButton doc={doc} />
                  <Button
                    aria-label="Open larger"
                    className="shrink-0"
                    onClick={() => setExpanded(true)}
                    size="icon"
                    title="Open larger"
                    type="button"
                    variant="ghost"
                  >
                    <Maximize2 />
                  </Button>
                </>
              ),
            }}
            isFocusDrawer
            isSinglePanelView
            onClose={closeHtmlDocument}
            onResetWidth={() => {}}
            onResizeStart={() => {}}
            title={doc.filename}
            useSplitAuxiliaryPane={false}
            widthPx={0}
          >
            <HtmlReportFrame
              className="overflow-hidden rounded-lg border border-border/60"
              doc={doc}
              key={doc.loadKey}
            />
            {expanded ? (
              <HtmlReportDialog doc={doc} onClose={() => setExpanded(false)} />
            ) : null}
          </IdleAuxiliaryPanel>
        </FocusThreadDrawer>
      ) : null}
    </AnimatePresence>
  );
}
