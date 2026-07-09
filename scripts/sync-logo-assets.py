#!/usr/bin/env python3
"""Regenerate every WebBrain logo derivative from the canonical brand assets.

The full-background artwork works well for social cards. Toolbar, favicon,
and store-icon sizes use the matching transparent brain mark so browser chrome
does not show it as a tiny boxed thumbnail. Requires Pillow.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "assets" / "logo-github.png"
MARK = ROOT / "assets" / "logo-mark.png"
ASSETS = ROOT / "assets"
WEB = ROOT / "web"


def full_logo(source: Image.Image, size: int) -> Image.Image:
    return source.resize((size, size), Image.Resampling.LANCZOS)


def icon_logo(mark: Image.Image, size: int) -> Image.Image:
    """Crop the transparent mark around its alpha bounds with even padding."""
    bounds = mark.getchannel("A").getbbox()
    if not bounds:
        raise SystemExit("Transparent logo mark has no visible pixels")

    left, top, right, bottom = bounds
    subject_side = max(right - left, bottom - top)
    side = round(subject_side * 1.14)
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    crop_left = round(center_x - side / 2)
    crop_top = round(center_y - side / 2)
    cropped = mark.crop((crop_left, crop_top, crop_left + side, crop_top + side))
    return cropped.resize((size, size), Image.Resampling.LANCZOS)


def wide_social_logo(source: Image.Image, width: int, height: int) -> Image.Image:
    """Center the full logo on a row-matched background for seamless sides."""
    square = full_logo(source, height).convert("RGB")
    canvas = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(canvas)
    for y in range(height):
        left = square.getpixel((0, y))
        right = square.getpixel((height - 1, y))
        color = tuple((left[i] + right[i]) // 2 for i in range(3))
        draw.line((0, y, width, y), fill=color)
    canvas.paste(square, ((width - height) // 2, 0))
    return canvas


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def main() -> None:
    source = Image.open(CANONICAL).convert("RGB")
    if source.size != (1254, 1254):
        raise SystemExit(f"Unexpected canonical logo size: {source.size}; expected 1254×1254")
    mark = Image.open(MARK).convert("RGBA")
    if mark.size != source.size:
        raise SystemExit(f"Unexpected transparent logo mark size: {mark.size}; expected {source.size}")

    save_png(full_logo(source, 512), ASSETS / "logo-github-512.png")
    full_logo(source, 512).save(
        ASSETS / "logo-github-512.jpg",
        format="JPEG",
        quality=94,
        optimize=True,
        progressive=True,
    )

    for size in (64, 128):
        save_png(icon_logo(mark, size), ASSETS / f"store-icon-{size}.png")

    for browser in ("chrome", "firefox"):
        icon_dir = ROOT / "src" / browser / "icons"
        for size in (16, 48, 128):
            save_png(icon_logo(mark, size), icon_dir / f"icon{size}.png")

    shutil.copyfile(CANONICAL, WEB / "logo-github.png")
    save_png(icon_logo(mark, 64), WEB / "favicon.png")
    save_png(full_logo(source, 512), WEB / "twitter-image.png")
    save_png(wide_social_logo(source, 1200, 630), WEB / "og-image.png")

    print("Synchronized WebBrain logo assets from assets/logo-github.png")


if __name__ == "__main__":
    main()
