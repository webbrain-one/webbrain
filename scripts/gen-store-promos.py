#!/usr/bin/env python3
"""
Regenerate Chrome / Firefox Web Store promo tiles from the canonical
store-icon-128.png + the WebBrain brand colors. Produces:

  assets/store-promo-440x280.png   — Small promo tile (Chrome & Firefox)
  assets/store-promo-1400x560.png  — Marquee promo tile (Chrome)

Re-run whenever the icon or tagline changes:

  python3 scripts/gen-store-promos.py

Requires Pillow (already on the dev box; pip install Pillow if missing).
"""

from __future__ import annotations

import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ICON_PATH = ASSETS / "store-icon-128.png"

# ── Brand palette ─────────────────────────────────────────────────────
# Matches webbrain marketing site + extension settings UI.
BG_TOP = (30, 25, 61)      # sampled from prior store-promo top
BG_BOT = (49, 39, 98)      # sampled from prior store-promo bottom
ACCENT = (108, 99, 255)    # --accent
ACCENT2 = (167, 139, 250) # --accent gradient end (used in nameplate)
TEXT = (240, 240, 248)
TEXT_DIM = (170, 165, 200)
TEXT_DIM2 = (135, 130, 175)

# ── Font discovery ────────────────────────────────────────────────────
# Prefer SF Pro (mac default) then Helvetica Neue; fall back to default.
FONT_CANDIDATES = {
    "bold": [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/Library/Fonts/Arial Bold.ttf",
    ],
    "regular": [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/Library/Fonts/Arial.ttf",
    ],
}


def get_font(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES[weight]:
        if os.path.exists(path):
            try:
                # .ttc collections: index 1 is typically Bold for Helvetica
                index = 1 if (weight == "bold" and path.endswith(".ttc")) else 0
                return ImageFont.truetype(path, size, index=index)
            except Exception:
                continue
    return ImageFont.load_default()


# ── Compositing helpers ───────────────────────────────────────────────


def vertical_gradient(w: int, h: int, top: tuple, bot: tuple) -> Image.Image:
    """Cheap, vectorized vertical gradient."""
    grad = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / (h - 1) if h > 1 else 0
        grad.putpixel(
            (0, y),
            (
                int(top[0] + (bot[0] - top[0]) * t),
                int(top[1] + (bot[1] - top[1]) * t),
                int(top[2] + (bot[2] - top[2]) * t),
            ),
        )
    return grad.resize((w, h)).convert("RGBA")


def radial_glow(
    size: tuple, center: tuple, radius: int, color: tuple, alpha: int
) -> Image.Image:
    """A soft circular glow we paste behind the icon for depth."""
    w, h = size
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    cx, cy = center
    # Draw progressively smaller concentric circles to fake a radial gradient
    # without doing per-pixel math. Looks identical past a slight blur.
    steps = 24
    for i in range(steps, 0, -1):
        r = int(radius * (i / steps))
        a = int(alpha * ((steps - i) / steps) ** 2)
        draw.ellipse(
            [(cx - r, cy - r), (cx + r, cy + r)],
            fill=(color[0], color[1], color[2], a),
        )
    return glow.filter(ImageFilter.GaussianBlur(radius * 0.18))


def fit_icon(icon: Image.Image, target_size: int) -> Image.Image:
    """Resize the source icon preserving alpha, sharp downscale."""
    return icon.resize((target_size, target_size), Image.LANCZOS)


# ── Tile renderers ────────────────────────────────────────────────────


def render_small_tile(icon: Image.Image) -> Image.Image:
    """440 × 280 — Chrome Web Store small promo tile (Firefox icon too).

    Layout mirrors the previous version (icon left, text right) so the
    listing's visual identity is preserved — only the W mark is replaced
    with the brain icon.
    """
    W, H = 440, 280
    img = vertical_gradient(W, H, BG_TOP, BG_BOT)

    # Soft purple glow behind the icon for depth.
    glow = radial_glow((W, H), center=(100, 138), radius=90, color=ACCENT, alpha=120)
    img = Image.alpha_composite(img, glow)

    # Brain icon, sized to roughly the same footprint as the old "W" disk.
    icon_size = 110
    icon_resized = fit_icon(icon, icon_size)
    img.alpha_composite(icon_resized, dest=(100 - icon_size // 2, 138 - icon_size // 2))

    # Text block, right-aligned to icon.
    draw = ImageDraw.Draw(img)
    text_x = 175
    title_f = get_font(40, "bold")
    sub_f = get_font(16, "regular")
    tag_f = get_font(15, "regular")

    draw.text((text_x, 100), "WebBrain", font=title_f, fill=TEXT)
    draw.text(
        (text_x, 152),
        "Open-Source AI Browser Agent",
        font=sub_f,
        fill=TEXT_DIM,
    )
    draw.text(
        (text_x, 178),
        "Any LLM. Any Page. Your Data.",
        font=tag_f,
        fill=TEXT_DIM2,
    )

    return img.convert("RGB")


def render_marquee_tile(icon: Image.Image) -> Image.Image:
    """1400 × 560 — Chrome Web Store marquee promo tile.

    Wider aspect ratio (2.5:1) than the small tile (≈1.57:1) so the layout
    is rebalanced: bigger icon on the left, two-line headline + tagline
    on the right, with feature pills underneath. Designed to read at the
    thumbnail size the store uses on category pages.
    """
    W, H = 1400, 560
    img = vertical_gradient(W, H, BG_TOP, BG_BOT)

    # Large purple glow under the icon — gives the marquee its visual focal
    # point.
    glow = radial_glow(
        (W, H), center=(330, 280), radius=240, color=ACCENT, alpha=140
    )
    img = Image.alpha_composite(img, glow)

    # Secondary, smaller glow tucked behind the text block for color
    # cohesion at the wider format.
    glow2 = radial_glow(
        (W, H), center=(1100, 480), radius=200, color=ACCENT2, alpha=60
    )
    img = Image.alpha_composite(img, glow2)

    # Brain icon scaled up. Source PNG is 128px so we don't oversample
    # by much — at 280px it stays crisp.
    icon_size = 280
    icon_resized = fit_icon(icon, icon_size)
    img.alpha_composite(icon_resized, dest=(330 - icon_size // 2, 280 - icon_size // 2))

    # Text block to the right.
    draw = ImageDraw.Draw(img)
    text_x = 540
    title_f = get_font(108, "bold")
    sub_f = get_font(36, "regular")
    tag_f = get_font(30, "regular")
    pill_f = get_font(20, "bold")

    draw.text((text_x, 160), "WebBrain", font=title_f, fill=TEXT)
    draw.text(
        (text_x, 296),
        "Open-Source AI Browser Agent",
        font=sub_f,
        fill=TEXT_DIM,
    )
    draw.text(
        (text_x, 348),
        "Any LLM. Any Page. Your Data.",
        font=tag_f,
        fill=TEXT_DIM2,
    )

    # Feature pills along the bottom of the text block — calls out the
    # "free, multi-provider, open source" story the listing also emphasises.
    pills = ["MIT LICENSED", "11+ PROVIDERS", "LOCAL OR CLOUD", "MV3 & MV2"]
    px = text_x
    py = 426
    pill_pad_x, pill_pad_y = 18, 10
    pill_gap = 14
    for label in pills:
        bbox = draw.textbbox((0, 0), label, font=pill_f)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        pill_w = tw + pill_pad_x * 2
        pill_h = th + pill_pad_y * 2
        # Soft translucent pill on the dark bg.
        pill = Image.new("RGBA", (pill_w, pill_h), (0, 0, 0, 0))
        pill_draw = ImageDraw.Draw(pill)
        pill_draw.rounded_rectangle(
            [(0, 0), (pill_w - 1, pill_h - 1)],
            radius=pill_h // 2,
            fill=(108, 99, 255, 50),
            outline=(167, 139, 250, 120),
            width=1,
        )
        pill_draw.text((pill_pad_x, pill_pad_y - bbox[1]), label, font=pill_f, fill=TEXT)
        img.alpha_composite(pill, dest=(px, py))
        px += pill_w + pill_gap

    return img.convert("RGB")


# ── Main ──────────────────────────────────────────────────────────────


def main() -> None:
    if not ICON_PATH.exists():
        raise SystemExit(f"icon not found: {ICON_PATH}")
    icon = Image.open(ICON_PATH).convert("RGBA")

    small = render_small_tile(icon)
    small_out = ASSETS / "store-promo-440x280.png"
    small.save(small_out, "PNG", optimize=True)
    print(f"wrote {small_out.relative_to(ROOT)} ({small.size[0]}×{small.size[1]})")

    marquee = render_marquee_tile(icon)
    marquee_out = ASSETS / "store-promo-1400x560.png"
    marquee.save(marquee_out, "PNG", optimize=True)
    print(
        f"wrote {marquee_out.relative_to(ROOT)} ({marquee.size[0]}×{marquee.size[1]})"
    )


if __name__ == "__main__":
    main()
