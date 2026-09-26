import { AnimatePresence } from "motion/react";
import * as React from "react";

import {
  closeHtmlDocument,
  useHtmlDocumentHost,
} from "@/shared/ui/markdown/htmlDocumentPanel";
import { useHtmlDocumentParts } from "@/shared/ui/markdown/HtmlReportDialog";
import type { ChannelScreenProps } from "./ChannelScreen.types";
import { FocusThreadDrawer } from "./FocusThreadDrawer";
import { IdleAuxiliaryPanel } from "./IdleAuxiliaryPanel";

/*
 * The HTML viewer's two hosts. Both show the same parts from
 * `useHtmlDocumentParts` in the same chrome — the focus drawer holding an
 * `IdleAuxiliaryPanel` — so a report looks and behaves alike in a channel and
 * on a project page. A channel routes through its own side-panel slot so the
 * viewer stacks correctly over (and Escape closes it before) a panel already
 * open there.
 */

type AuxiliaryProps = Pick<
  ChannelScreenProps,
  | "idleAuxiliaryHeaderActions"
  | "idleAuxiliaryOverridesThread"
  | "idleAuxiliaryPanel"
  | "idleAuxiliaryTitle"
  | "onCloseIdleAuxiliaryPanel"
>;

/**
 * Shows an open document in the channel's side panel, in front of whatever
 * panel the screen was showing; closing it brings that panel back as it was.
 */
export function useHtmlDocumentAuxiliary(
  channelId: string | null,
  props: AuxiliaryProps,
): AuxiliaryProps {
  const parts = useHtmlDocumentParts(useHtmlDocumentHost());

  // biome-ignore lint/correctness/useExhaustiveDependencies: a channel switch closes the document
  React.useEffect(() => {
    closeHtmlDocument();
  }, [channelId]);

  // The same two-slot shape either way, so the screen's own panel (a PR the
  // person drilled into) stays mounted behind the document.
  const layered = (front: React.ReactNode) => (
    <>
      {front}
      <div className={front ? "hidden" : "contents"}>
        {props.idleAuxiliaryPanel}
      </div>
    </>
  );

  if (!parts) {
    return props.idleAuxiliaryPanel
      ? { ...props, idleAuxiliaryPanel: layered(null) }
      : props;
  }
  return {
    idleAuxiliaryHeaderActions: { actions: parts.actions },
    idleAuxiliaryOverridesThread: true,
    idleAuxiliaryPanel: layered(parts.body),
    idleAuxiliaryTitle: parts.title,
    onCloseIdleAuxiliaryPanel: closeHtmlDocument,
  };
}

/**
 * Registers a screen without a channel side panel as the viewer's host and
 * shows the open document over it. Render inside the screen's relative layout
 * root.
 */
export function HtmlDocumentDrawer({ label }: { label: string }) {
  const parts = useHtmlDocumentParts(useHtmlDocumentHost());
  return (
    <AnimatePresence>
      {parts ? (
        <FocusThreadDrawer
          channelName={label}
          key="html-document"
          label={parts.title}
          onClose={closeHtmlDocument}
        >
          <IdleAuxiliaryPanel
            canResetWidth={false}
            headerControls={{ actions: parts.actions }}
            isFocusDrawer
            isSinglePanelView
            onClose={closeHtmlDocument}
            onResetWidth={() => {}}
            onResizeStart={() => {}}
            title={parts.title}
            useSplitAuxiliaryPane={false}
            widthPx={0}
          >
            {parts.body}
          </IdleAuxiliaryPanel>
        </FocusThreadDrawer>
      ) : null}
    </AnimatePresence>
  );
}
