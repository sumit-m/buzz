import { useQuery } from "@tanstack/react-query";
import type * as React from "react";

import { parseImageSidecar } from "@/features/projects/ui/imageSidecar";
import { ImageInfoSidebar } from "@/features/projects/ui/ImageInfoSidebar";
import { fetchMediaBytes } from "@/shared/api/tauriMedia";

import { ImageBoxContext, SIDECAR_IMAGE_BOX } from "./imageBox";
import { findSidecarUrl } from "./imageSidecarMatch";
import { useMarkdownRuntime } from "./runtimeContext";

/**
 * LOCAL DIVERGENCE: a message image whose `.json` sidecar is attached to the
 * same message (same file name stem, as mage-agent posts them) shows an info
 * sidebar beside it, and the sidecar's own file card is hidden.
 */

/** A message video's inset, matching the other inset media. */
export const VIDEO_INSET_CLASS = "mx-1.5 max-w-[calc(100%-0.75rem)]";

/**
 * The block-media wrapper of a message image. With a sidecar attached, the
 * image and its info sidebar sit side by side (stacked when narrow).
 */
export function ImageSidecarFrame({
  children,
  src,
}: {
  children: React.ReactNode;
  src: string | undefined;
}) {
  const { imetaByUrl } = useMarkdownRuntime();
  const sidecarUrl = src ? findSidecarUrl(imetaByUrl, src) : null;
  const sidecar = useQuery({
    enabled: sidecarUrl !== null,
    queryKey: ["message-image-sidecar", sidecarUrl],
    queryFn: async ({ signal }) =>
      parseImageSidecar(
        new TextDecoder("utf-8").decode(
          await fetchMediaBytes(sidecarUrl ?? "", signal),
        ),
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (sidecarUrl === null) {
    return (
      <span data-block-media="" className="block min-w-0 max-w-full">
        {children}
      </span>
    );
  }
  return (
    <ImageBoxContext.Provider value={SIDECAR_IMAGE_BOX}>
      <span
        className="flex min-w-0 max-w-full flex-wrap items-start gap-4"
        data-block-media=""
        data-testid="message-image-with-sidecar"
      >
        <span className="block min-w-0 max-w-full">{children}</span>
        {sidecar.data ? (
          <span className="block min-w-0 max-w-[400px] flex-1 basis-64">
            <ImageInfoSidebar
              context={
                src ? { kind: "chat", imageUrl: src, sidecarUrl } : undefined
              }
              sidecar={sidecar.data}
            />
          </span>
        ) : null}
      </span>
    </ImageBoxContext.Provider>
  );
}
