const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RELAY_HTML_PATH_RE = /^\/media\/[\da-f]{64}\.html?$/;
const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

/**
 * Locks a rendered report to its own bytes: inline styles, embedded fonts and
 * images only. The frame is also sandboxed without scripts; this stops a
 * member-uploaded page from fetching anything (tracking pixels, remote CSS).
 */
export const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:";

export function isHtmlFilename(filename: string): boolean {
  return /\.html?$/i.test(filename);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function portOf(url: URL): string {
  return url.port || DEFAULT_PORTS[url.protocol] || "";
}

/**
 * Whether `href` is an HTML file hosted on this relay. A loopback relay is one
 * server however it is spelled: it stamps upload URLs with the uploader's
 * Host, so an agent's `127.0.0.1` link belongs to a `localhost` desktop.
 */
export function isRelayHtmlReport(
  href: string,
  relayOrigin: string | null | undefined,
): boolean {
  if (!relayOrigin) return false;
  const target = parseUrl(href);
  const relay = parseUrl(relayOrigin);
  if (!target || !relay || !RELAY_HTML_PATH_RE.test(target.pathname)) {
    return false;
  }
  if (target.origin === relay.origin) return true;
  return (
    LOOPBACK_HOSTS.has(target.hostname) &&
    LOOPBACK_HOSTS.has(relay.hostname) &&
    target.protocol === relay.protocol &&
    portOf(target) === portOf(relay)
  );
}

const LEADING_PROLOGUE_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>)?/i;

/**
 * Put the report CSP ahead of any markup that could load something, but after
 * the doctype so the page keeps standards-mode layout.
 */
export function withReportCsp(html: string): string {
  const prologue = LEADING_PROLOGUE_RE.exec(html)?.[0] ?? "";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;
  return `${prologue}${meta}${html.slice(prologue.length)}`;
}
