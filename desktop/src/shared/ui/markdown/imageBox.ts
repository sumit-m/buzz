import * as React from "react";

/**
 * LOCAL DIVERGENCE: the box a message image is scaled down to fit. Images with
 * an info sidebar get a larger one (see `ImageSidecarFrame`).
 */
export const MESSAGE_IMAGE_BOX = { height: 256, width: 384 } as const;
export const SIDECAR_IMAGE_BOX = { height: 400, width: 480 } as const;

export const ImageBoxContext = React.createContext<{
  height: number;
  width: number;
}>(MESSAGE_IMAGE_BOX);
