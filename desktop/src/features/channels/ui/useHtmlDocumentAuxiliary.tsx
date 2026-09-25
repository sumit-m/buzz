import { Maximize2 } from "lucide-react";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  closeHtmlDocument,
  useHtmlDocumentHost,
} from "@/shared/ui/markdown/htmlDocumentPanel";
import {
  HtmlReportDialog,
  HtmlReportDownloadButton,
  HtmlReportFrame,
} from "@/shared/ui/markdown/HtmlReportDialog";
import type { ChannelScreenProps } from "./ChannelScreen.types";

type AuxiliaryProps = Pick<
  ChannelScreenProps,
  | "idleAuxiliaryHeaderActions"
  | "idleAuxiliaryOverridesThread"
  | "idleAuxiliaryPanel"
  | "idleAuxiliaryTitle"
  | "onCloseIdleAuxiliaryPanel"
>;

/**
 * Docks an open HTML document in the channel's side panel, in front of
 * whatever panel the screen was showing; closing it brings that panel back.
 */
export function useHtmlDocumentAuxiliary(
  channelId: string | null,
  props: AuxiliaryProps,
): AuxiliaryProps {
  const doc = useHtmlDocumentHost();
  const [expanded, setExpanded] = React.useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a channel switch closes the document
  React.useEffect(() => {
    closeHtmlDocument();
  }, [channelId]);
  React.useEffect(() => {
    if (!doc) setExpanded(false);
  }, [doc]);

  // The same two-slot shape either way, so the screen's own panel (a PR the
  // person drilled into) stays mounted behind the document and comes back as
  // it was.
  const layered = (front: React.ReactNode) => (
    <>
      {front}
      <div className={front ? "hidden" : "contents"}>
        {props.idleAuxiliaryPanel}
      </div>
    </>
  );

  if (!doc) {
    return props.idleAuxiliaryPanel
      ? { ...props, idleAuxiliaryPanel: layered(null) }
      : props;
  }
  return {
    idleAuxiliaryHeaderActions: {
      actions: (
        <>
          <HtmlReportDownloadButton doc={doc} />
          <Button
            aria-label="Open larger"
            className="shrink-0"
            data-testid="html-document-expand"
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
    },
    idleAuxiliaryOverridesThread: true,
    idleAuxiliaryPanel: layered(
      <>
        <HtmlReportFrame
          className="overflow-hidden rounded-lg border border-border/60"
          doc={doc}
          key={doc.loadKey}
        />
        {expanded ? (
          <HtmlReportDialog doc={doc} onClose={() => setExpanded(false)} />
        ) : null}
      </>,
    ),
    idleAuxiliaryTitle: doc.filename,
    onCloseIdleAuxiliaryPanel: closeHtmlDocument,
  };
}
