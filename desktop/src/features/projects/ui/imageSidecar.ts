/**
 * The `.json` file saved next to a generated image (same folder, same name):
 * its prompt plus labelled fields for the image view's info sidebar.
 */

export type SidecarField = {
  label: string;
  value: string;
};

/** The upload an edit started from, as its imeta fields. */
export type SidecarSource = {
  url: string;
  m?: string;
  x?: string;
  size?: string;
  dim?: string;
};

/**
 * What mage-agent adds as `buzz`: how the image was made, the uploads it was
 * made from (in order), and the repo it was saved to (`<owner>/<repo>`).
 * Older sidecars have none, or a single `source`.
 */
export type ImageOrigin = {
  mode: "generate" | "edit";
  sources: SidecarSource[];
  repo: string | null;
};

export type ImageSidecar = {
  prompt: string | null;
  fields: SidecarField[];
  /** Every scalar value by its key, for starting an edit from this image. */
  values: Record<string, string>;
  origin: ImageOrigin | null;
};

/** Shown elsewhere (file name, prompt, dimensions) or not wanted in the sidebar. */
const HIDDEN_KEYS = new Set([
  "name",
  "prompt",
  "result_url",
  "width",
  "height",
  "generation_mode",
  "status",
  "expires_at",
  "history_id",
]);

const KNOWN_FIELDS: Array<{
  key: string;
  label: string;
  format?: (value: unknown) => string | null;
}> = [
  { key: "model_id", label: "Model" },
  { key: "architecture", label: "Architecture" },
  { key: "dimensions", label: "Dimensions" },
  { key: "resolution", label: "Resolution" },
  { key: "aspect_ratio", label: "Aspect Ratio" },
  {
    key: "duration_sec",
    label: "Duration",
    format: (value) =>
      typeof value === "number" ? `${Math.round(value * 10) / 10}s` : null,
  },
  { key: "type", label: "Type" },
  { key: "created_at", label: "Created", format: formatDate },
];

export function sidecarPathFor(imagePath: string): string {
  const slash = imagePath.lastIndexOf("/");
  const dot = imagePath.lastIndexOf(".");
  const stem = dot > slash + 1 ? imagePath.slice(0, dot) : imagePath;
  return `${stem}.json`;
}

function formatDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = date.toLocaleDateString(undefined, { dateStyle: "medium" });
  const time = date.toLocaleTimeString(undefined, { timeStyle: "short" });
  return `${day} ${time}`;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function titleCase(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function parseImageSidecar(text: string): ImageSidecar | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = { ...(data as Record<string, unknown>) };
  if (typeof record.width === "number" && typeof record.height === "number") {
    record.dimensions = `${record.width} × ${record.height}`;
  }

  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const value = scalarText(raw);
    if (value) values[key] = value;
  }

  const fields: SidecarField[] = [];
  const used = new Set(HIDDEN_KEYS);
  for (const known of KNOWN_FIELDS) {
    used.add(known.key);
    if (!(known.key in record)) continue;
    const value = (known.format ?? scalarText)(record[known.key]);
    if (value) fields.push({ label: known.label, value });
  }
  for (const [key, raw] of Object.entries(record)) {
    if (used.has(key)) continue;
    const value = scalarText(raw);
    if (value) fields.push({ label: titleCase(key), value });
  }

  return {
    prompt: scalarText(record.prompt),
    fields,
    values,
    origin: parseOrigin(record.buzz),
  };
}

function parseOrigin(raw: unknown): ImageOrigin | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const origin = raw as Record<string, unknown>;
  if (origin.mode !== "generate" && origin.mode !== "edit") return null;
  const listed = Array.isArray(origin.sources)
    ? origin.sources
    : origin.source
      ? [origin.source]
      : [];
  const sources = listed.flatMap((raw) => {
    const source = parseSource(raw);
    return source ? [source] : [];
  });
  return { mode: origin.mode, sources, repo: scalarText(origin.repo) };
}

function parseSource(raw: unknown): SidecarSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const url = scalarText(fields.url);
  if (!url || !/^https?:\/\//.test(url)) return null;
  const source: SidecarSource = { url };
  for (const key of ["m", "x", "size", "dim"] as const) {
    const value = scalarText(fields[key]);
    if (value) source[key] = value;
  }
  return source;
}
