#!/usr/bin/env python3
"""Rebuild the desktop icon set from local artwork.

Upstream's `buzz-source.png` has no alpha channel (PNG colortype 2), so
`tauri icon` bakes an opaque black square into every platform's desktop icons.
This regenerates them from a transparent master in `icons/local-art/`.

On Windows every icon the user actually sees comes out of `icon.ico` --
tauri-codegen wires it to `default_window_icon`, and Windows picks 16px for the
title bar and 24/32px for the taskbar.

Local-only: this artwork is not ours to ship. Never push this branch, and
re-run after any rebase that touches `desktop/src-tauri/icons/`.

    python scripts/local-transparent-icons.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "desktop/src-tauri/icons"
MASTER = ICONS / "local-art/docker.png"

PNG_TARGETS = {
    "icon.png": 512,
    "128x128@2x.png": 256,
    "128x128.png": 128,
    "64x64.png": 64,
    "32x32.png": 32,
    "Square310x310Logo.png": 310,
    "Square284x284Logo.png": 284,
    "Square150x150Logo.png": 150,
    "Square142x142Logo.png": 142,
    "Square107x107Logo.png": 107,
    "Square89x89Logo.png": 89,
    "Square71x71Logo.png": 71,
    "StoreLogo.png": 50,
    "Square44x44Logo.png": 44,
    "Square30x30Logo.png": 30,
}
ICO_SIZES = (16, 24, 32, 48, 64, 256)


def square(image: Image.Image) -> Image.Image:
    """Pad to a centred square so non-square artwork keeps its aspect ratio."""
    side = max(image.size)
    if image.size == (side, side):
        return image
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def main() -> int:
    if not MASTER.exists():
        raise SystemExit(f"missing artwork: {MASTER}")
    master = square(Image.open(MASTER).convert("RGBA"))

    def render(size: int) -> Image.Image:
        return master.resize((size, size), Image.LANCZOS)

    for name, size in PNG_TARGETS.items():
        render(size).save(ICONS / name)

    render(max(ICO_SIZES)).save(ICONS / "icon.ico", sizes=[(s, s) for s in ICO_SIZES])

    print(f"rebuilt {len(PNG_TARGETS) + 1} icons from {MASTER.name} ({master.width}px)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
