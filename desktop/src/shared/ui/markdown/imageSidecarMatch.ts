import type { ImetaLookup } from "./types";

/**
 * LOCAL DIVERGENCE: matching a message image to its `.json` sidecar attached
 * to the same message (same file name stem, as mage-agent posts them).
 */

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return (dot > 0 ? filename.slice(0, dot) : filename).toLowerCase();
}

function isJson(filename: string | undefined, mime: string | undefined) {
  return (
    mime === "application/json" ||
    (filename?.toLowerCase().endsWith(".json") ?? false)
  );
}

/** The sidecar URL attached beside image `src`, if any. */
export function findSidecarUrl(
  imetaByUrl: ImetaLookup | undefined,
  src: string,
): string | null {
  const image = imetaByUrl?.get(src);
  if (!imetaByUrl || !image?.filename || !image.m?.startsWith("image/")) {
    return null;
  }
  const imageStem = stem(image.filename);
  for (const [url, entry] of imetaByUrl) {
    if (
      entry.filename &&
      isJson(entry.filename, entry.m) &&
      stem(entry.filename) === imageStem
    ) {
      return url;
    }
  }
  return null;
}

/** True when `filename` is the `.json` sidecar of an image in the same message. */
export function isImageSidecarFile(
  imetaByUrl: ImetaLookup | undefined,
  filename: string,
): boolean {
  if (!imetaByUrl || !filename.toLowerCase().endsWith(".json")) return false;
  const sidecarStem = stem(filename);
  for (const entry of imetaByUrl.values()) {
    if (
      entry.filename &&
      entry.m?.startsWith("image/") &&
      stem(entry.filename) === sidecarStem
    ) {
      return true;
    }
  }
  return false;
}
