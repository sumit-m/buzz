import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { invokeTauri } from "@/shared/api/tauri";
import { fetchMediaBytes } from "@/shared/api/tauriMedia";
import { cn } from "@/shared/lib/cn";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";

import { SyntaxHighlightedCode } from "./CodeBlock";
import { type HtmlDocument, openHtmlDocument } from "./htmlDocumentPanel";
import {
  isHtmlFilename,
  prettyJson,
  withReportCsp,
  withViewerTheme,
} from "./htmlReport";

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
  };
}

/** A relay-hosted JSON file, pretty-printed and highlighted; downloads the original. */
export function relayJsonDocument(
  href: string,
  filename: string,
): HtmlDocument {
  return {
    filename,
    load: async (signal) =>
      prettyJson(
        new TextDecoder("utf-8").decode(await fetchMediaBytes(href, signal)),
      ),
    loadKey: href,
    language: "json",
    download: () => downloadRelayFile(href, filename),
  };
}

/**
 * Fetches a document's HTML with its own credentials: relay media and relay
 * git both need a member's signature, which a browser does not have.
 */
function useHtmlDocumentState(doc: HtmlDocument | null): LoadState {
  const [state, setState] = React.useState<LoadState>({ phase: "loading" });
  const loadRef = React.useRef(doc?.load);
  loadRef.current = doc?.load;
  const loadKey = doc?.loadKey;

  React.useEffect(() => {
    const load = loadRef.current;
    if (!loadKey || !load) return;
    const controller = new AbortController();
    setState({ phase: "loading" });
    load(controller.signal)
      .then((html) => {
        if (!controller.signal.aborted) setState({ phase: "ready", html });
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

  return state;
}

/** Renders the HTML in a frame with no scripts and no network, in the app's theme. */
function HtmlReportFrame({
  className,
  filename,
  language,
  state,
}: {
  className?: string;
  filename: string;
  language?: string;
  state: LoadState;
}) {
  const { isDark } = useTheme();
  return (
    <div className={cn("h-full min-h-0 flex-1", className)}>
      {state.phase === "ready" && language ? (
        <pre
          className="h-full overflow-auto bg-background/60 p-4"
          data-testid="html-report-source"
        >
          <SyntaxHighlightedCode
            className="whitespace-pre-wrap break-words text-xs leading-relaxed"
            code={state.html}
            language={language}
          />
        </pre>
      ) : state.phase === "ready" ? (
        <iframe
          className="h-full w-full border-0"
          data-testid="html-report-frame"
          referrerPolicy="no-referrer"
          sandbox=""
          srcDoc={withViewerTheme(withReportCsp(state.html), isDark)}
          style={{ colorScheme: isDark ? "dark" : "light" }}
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
  );
}

function HtmlDocumentDownloadButton({
  download,
  filename,
  state,
}: {
  download?: () => void;
  filename: string;
  state: LoadState;
}) {
  return (
    <Button
      aria-label="Download"
      className="shrink-0"
      disabled={state.phase !== "ready"}
      onClick={() => {
        if (state.phase !== "ready") return;
        if (download) {
          download();
          return;
        }
        invokeTauri("save_html_file", { filename, html: state.html }).catch(
          (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Download failed");
          },
        );
      }}
      size="icon"
      title="Download"
      type="button"
      variant="ghost"
    >
      <Download />
    </Button>
  );
}

export type HtmlDocumentParts = {
  actions: React.ReactNode;
  body: React.ReactNode;
  title: string;
};

/**
 * Everything the HTML viewer shows, whichever panel hosts it: the title, the
 * header actions and the rendered page. Hosts supply only their chrome.
 */
export function useHtmlDocumentParts(
  doc: HtmlDocument | null,
): HtmlDocumentParts | null {
  const state = useHtmlDocumentState(doc);
  if (!doc) return null;
  return {
    actions: (
      <HtmlDocumentDownloadButton
        download={doc.download}
        filename={doc.filename}
        state={state}
      />
    ),
    body: (
      <HtmlReportFrame
        className="overflow-hidden rounded-lg border border-border/60"
        filename={doc.filename}
        language={doc.language}
        state={state}
      />
    ),
    title: doc.filename,
  };
}

/** Where a screen has no panel to dock the viewer in. */
function HtmlReportDialog({
  doc,
  onClose,
}: {
  doc: HtmlDocument;
  onClose: () => void;
}) {
  const parts = useHtmlDocumentParts(doc);
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
              {parts?.title}
            </DialogTitle>
            {parts?.actions}
          </div>
          <DialogDescription className="sr-only">
            File preview
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col p-4">{parts?.body}</div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Opens a document in the docked drawer, or in a dialog where the screen has
 * no drawer to dock it in.
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
