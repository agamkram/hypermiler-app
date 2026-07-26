#!/usr/bin/env python3
"""Generate HyperMiler home-screen icons — soft green gauge needle."""

from __future__ import annotations

from pathlib import Path
import math

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]

BG = (10, 14, 20)
SURFACE = (18, 26, 36)
ACCENT = (52, 211, 153)
ACCENT_SOFT = (61, 156, 245)
MUTED = (125, 143, 163)
FRAME = (232, 237, 244)


def build_icon(size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BG + (255,))

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        (size * 0.18, size * 0.18, size * 0.82, size * 0.82),
        fill=ACCENT + (40,),
    )
    canvas = Image.alpha_composite(
        canvas, glow.filter(ImageFilter.GaussianBlur(radius=size // 16))
    )

    draw = ImageDraw.Draw(canvas)
    cx = cy = size * 0.5
    r = size * 0.32

    # Outer ring
    draw.ellipse(
        (cx - r, cy - r, cx + r, cy + r),
        outline=SURFACE,
        width=max(4, size // 36),
    )
    draw.ellipse(
        (cx - r, cy - r, cx + r, cy + r),
        outline=ACCENT_SOFT,
        width=max(2, size // 64),
    )

    # Arc ticks (smooth zone)
    for i in range(7):
        ang = math.radians(210 - i * 20)
        x0 = cx + math.cos(ang) * (r * 0.72)
        y0 = cy - math.sin(ang) * (r * 0.72)
        x1 = cx + math.cos(ang) * (r * 0.88)
        y1 = cy - math.sin(ang) * (r * 0.88)
        draw.line((x0, y0, x1, y1), fill=MUTED, width=max(2, size // 90))

    # Needle — gentle (hypermile) angle
    ang = math.radians(145)
    nx = cx + math.cos(ang) * (r * 0.62)
    ny = cy - math.sin(ang) * (r * 0.62)
    draw.line((cx, cy, nx, ny), fill=ACCENT, width=max(4, size // 48))
    hub = max(4, size // 28)
    draw.ellipse((cx - hub, cy - hub, cx + hub, cy + hub), fill=FRAME)
    draw.ellipse(
        (cx - hub * 0.45, cy - hub * 0.45, cx + hub * 0.45, cy + hub * 0.45),
        fill=ACCENT,
    )

    return canvas.convert("RGB")


def save_icons() -> None:
    icon_512 = build_icon(512)
    icon_512.save(ROOT / "icon-512.png", "PNG")
    icon_180 = icon_512.resize((180, 180), Image.Resampling.LANCZOS)
    icon_180.save(ROOT / "apple-touch-icon.png", "PNG")
    print(f"Wrote {ROOT / 'icon-512.png'}")
    print(f"Wrote {ROOT / 'apple-touch-icon.png'}")


if __name__ == "__main__":
    save_icons()
