import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { invokeTauri } from "@/shared/api/tauri";
import { cn } from "@/shared/lib/cn";
import { fetchMediaBytes } from "@/shared/api/tauriMedia";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { type HtmlDocument, openHtmlDocument } from "./htmlDocumentPanel";
import { isHtmlFilename, withReportCsp } from "./htmlReport";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; html: string }
  | { phase: "error"; message: string };

export function downloadRelayFile(href: string, filename: string) {
  invokeTauri("download_file", { url: href, filename }).catch(
    (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Download failed");
    },
  );
}

export function relayHtmlDocument(
  href: string,
  filename: string,
): HtmlDocument {
  return {
    filename,
    load: async (signal) =>
      new TextDecoder("utf-8").decode(await fetchMediaBytes(href, signal)),
    loadKey: href,
    onDownload: () => downloadRelayFile(href, filename),
  };
}

/**
 * Renders an HTML file in a frame with no scripts and no network. The
 * document fetches its own bytes: relay media and relay git both need a
 * member's signature, which a browser does not have.
 */
export function HtmlReportFrame({
  className,
  doc,
}: {
  className?: string;
  doc: HtmlDocument;
}) {
  const [state, setState] = React.useState<LoadState>({ phase: "loading" });
  const loadRef = React.useRef(doc.load);
  loadRef.current = doc.load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadKey identifies the file
  React.useEffect(() => {
    const controller = new AbortController();
    setState({ phase: "loading" });
    loadRef
      .current(controller.signal)
      .then((html) => {
        if (controller.signal.aborted) return;
        setState({ phase: "ready", html: withReportCsp(html) });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
  }, [doc.loadKey]);

  return (
    <div className={cn("h-full min-h-0 flex-1 bg-white", className)}>
      {state.phase === "ready" ? (
        <iframe
          className="h-full w-full border-0"
          data-testid="html-report-frame"
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={state.html}
          title={doc.filename}
        />
      ) : (
        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
          {state.phase === "loading" ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            `Could not open ${doc.filename}: ${state.message}`
          )}
        </div>
      )}
    </div>
  );
}

export function HtmlReportDownloadButton({ doc }: { doc: HtmlDocument }) {
  if (!doc.onDownload) return null;
  return (
    <Button
      className="h-7 px-2"
      onClick={doc.onDownload}
      size="sm"
      type="button"
      variant="ghost"
    >
      <Download className="h-4 w-4" />
      Download
    </Button>
  );
}

export function HtmlReportDialog({
  doc,
  onClose,
}: {
  doc: HtmlDocument;
  onClose: () => void;
}) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent className="flex h-[90vh] w-full max-w-6xl flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b border-border/50 px-4 py-3 pr-14">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="min-w-0 truncate text-sm font-medium">
              {doc.filename}
            </DialogTitle>
            <HtmlReportDownloadButton doc={doc} />
          </div>
          <DialogDescription className="sr-only">
            HTML file preview
          </DialogDescription>
        </DialogHeader>
        <HtmlReportFrame doc={doc} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Opens a document in the docked side panel, or in a dialog where the screen
 * has no panel to dock it in.
 */
export function useHtmlDocumentViewer() {
  const [dialogDoc, setDialogDoc] = React.useState<HtmlDocument | null>(null);
  const open = React.useCallback((doc: HtmlDocument) => {
    if (!openHtmlDocument(doc)) setDialogDoc(doc);
  }, []);
  const dialog = dialogDoc ? (
    <HtmlReportDialog doc={dialogDoc} onClose={() => setDialogDoc(null)} />
  ) : null;
  return { dialog, open };
}

/** A plain link to a relay-hosted HTML file, opened in the viewer. */
export function HtmlReportLink({
  children,
  href,
  label,
}: {
  children: React.ReactNode;
  href: string;
  label: string;
}) {
  const viewer = useHtmlDocumentViewer();
  const filename = isHtmlFilename(label)
    ? label
    : `${label.trim() || "report"}.html`;

  return (
    <>
      <a
        className="font-medium text-primary underline underline-offset-4 transition-colors hover:text-primary/80"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          viewer.open(relayHtmlDocument(href, filename));
        }}
      >
        {children}
      </a>
      {viewer.dialog}
    </>
  );
}
