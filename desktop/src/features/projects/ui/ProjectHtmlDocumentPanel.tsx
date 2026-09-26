import { Maximize2 } from "lucide-react";
import * as React from "react";

import {
  AuxiliaryPanel,
  AuxiliaryPanelBody,
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderActions,
  AuxiliaryPanelHeaderGroup,
  AuxiliaryPanelTitle,
} from "@/shared/layout/AuxiliaryPanel";
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

/** The project page's right panel showing an open HTML document, docked like a channel's. */
export function ProjectHtmlDocumentPanel({
  canResetWidth,
  doc,
  onResetWidth,
  onResizeStart,
  widthPx,
}: {
  canResetWidth: boolean;
  doc: HtmlDocument;
  onResetWidth: () => void;
  onResizeStart: React.PointerEventHandler<HTMLButtonElement>;
  widthPx: number;
}) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <AuxiliaryPanel
      canResetWidth={canResetWidth}
      header={
        <AuxiliaryPanelHeader>
          <AuxiliaryPanelHeaderGroup>
            <AuxiliaryPanelTitle>{doc.filename}</AuxiliaryPanelTitle>
          </AuxiliaryPanelHeaderGroup>
          <AuxiliaryPanelHeaderActions>
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
          </AuxiliaryPanelHeaderActions>
        </AuxiliaryPanelHeader>
      }
      onClose={closeHtmlDocument}
      onResetWidth={onResetWidth}
      onResizeStart={onResizeStart}
      resizeHandleAriaLabel="Resize panel"
      splitPaneClamp={false}
      testId="project-html-document-panel"
      widthPx={widthPx}
    >
      <AuxiliaryPanelBody className="overflow-hidden px-4 pb-4">
        <HtmlReportFrame
          className="overflow-hidden rounded-lg border border-border/60"
          doc={doc}
          key={doc.loadKey}
        />
      </AuxiliaryPanelBody>
      {expanded ? (
        <HtmlReportDialog doc={doc} onClose={() => setExpanded(false)} />
      ) : null}
    </AuxiliaryPanel>
  );
}
