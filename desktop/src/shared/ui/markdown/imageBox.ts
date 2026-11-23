import * as React from "react";

/**
 * LOCAL DIVERGENCE: the box a message image is scaled down to fit. Images and
 * videos with an info sidebar share a larger one (see `ImageSidecarFrame`):
 * one width for every shape up to 3:4 (and mage portrait); taller ones are
 * capped in height.
 */
export const MESSAGE_IMAGE_BOX = { height: 256, width: 384 } as const;
export const SIDECAR_IMAGE_BOX = { height: 720, width: 512 } as const;

export const ImageBoxContext = React.createContext<{
  height: number;
  width: number;
}>(MESSAGE_IMAGE_BOX);
