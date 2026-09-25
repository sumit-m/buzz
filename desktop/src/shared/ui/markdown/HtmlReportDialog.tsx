import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { invokeTauri } from "@/shared/api/tauri";
import { fetchMediaBytes } from "@/shared/api/tauriMedia";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

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

async function loadRelayHtml(href: string, signal: AbortSignal) {
  const bytes = await fetchMediaBytes(href, signal);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Shows an HTML file in the app, rendered in a frame with no scripts and no
 * network. The caller fetches it with its own credentials: relay media and
 * relay git both need a member's signature, which a browser does not have.
 */
export function HtmlReportDialog({
  filename,
  load,
  loadKey,
  onClose,
  onDownload,
}: {
  filename: string;
  load: (signal: AbortSignal) => Promise<string>;
  /** Changes when `load` would return a different file. */
  loadKey: string;
  onClose: () => void;
  onDownload?: () => void;
}) {
  const [state, setState] = React.useState<LoadState>({ phase: "loading" });
  const loadRef = React.useRef(load);
  loadRef.current = load;

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
  }, [loadKey]);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent className="flex h-[90vh] w-full max-w-6xl flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b border-border/50 px-4 py-3 pr-14">
          <div className="flex items-center gap-2">
            <DialogTitle className="min-w-0 truncate text-sm font-medium">
              {filename}
            </DialogTitle>
            {onDownload ? (
              <Button
                className="ml-auto h-7 px-2"
                onClick={onDownload}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Download className="h-4 w-4" />
                Download
              </Button>
            ) : null}
          </div>
          <DialogDescription className="sr-only">
            HTML file preview
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 bg-white">
          {state.phase === "ready" ? (
            <iframe
              className="h-full w-full border-0"
              data-testid="html-report-frame"
              referrerPolicy="no-referrer"
              sandbox=""
              srcDoc={state.html}
              title={filename}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              {state.phase === "loading" ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                `Could not open ${filename}: ${state.message}`
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A relay-hosted HTML file (an attachment or a plain link) in the viewer. */
export function RelayHtmlDialog({
  filename,
  href,
  onClose,
}: {
  filename: string;
  href: string;
  onClose: () => void;
}) {
  return (
    <HtmlReportDialog
      filename={filename}
      load={(signal) => loadRelayHtml(href, signal)}
      loadKey={href}
      onClose={onClose}
      onDownload={() => downloadRelayFile(href, filename)}
    />
  );
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
  const [viewing, setViewing] = React.useState(false);
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
          setViewing(true);
        }}
      >
        {children}
      </a>
      {viewing ? (
        <RelayHtmlDialog
          filename={filename}
          href={href}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </>
  );
}
