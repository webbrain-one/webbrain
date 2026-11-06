"""Print the Murshid homepage's pictures as gold halftone, from public-domain
paintings and photographs (listed, with their licences, in sources/README.md).

    pip install opencv-python-headless numpy pillow
    python scripts/art/halftone.py        (or: npm run art:pictures)

Writes web/art/halftone/<slot>.webp: the hero, "The way" and the six feature
cards. Each is a printer's dot screen whose dots grow with the light. The ink
colour is written with the dot coverage as alpha, so the crimson and night
grounds of the page show between the dots.
"""

import math
import os

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(HERE, 'sources')
OUT = os.path.join(ROOT, 'web', 'art', 'halftone')

GOLD = (217, 174, 85)
PARCHMENT = (244, 234, 214)

# slot: (source picture, crop box (left, top, right, bottom) in that picture,
#        output width, aspect (width / height), screen cell in pixels)
# Gold ink needs a figure lighter than its ground: white robes, white turbans.
SLOTS = {
    'hero': ('theologian-with-koran-osman-hamdi-1902.jpg', (0, 0, 1250, 1600), 1120, 100 / 128, 7.5),
    'way': ('dervish-vanmour-rijksmuseum-sk-a-2030.jpg', (0, 0, 1480, 2120), 1000, None, 6.5),
    'card-browse': ('public-scribe-osman-hamdi-1910.jpg', (0, 0, 1060, 662), 800, 16 / 10, 6.5),
    'card-ask': ('theologian-with-koran-osman-hamdi-1902.jpg', (0, 120, 960, 720), 800, 16 / 10, 6.5),
    'card-tray': ('dervishes-with-instruments-rijksmuseum-rp-f-00-6419.jpg', (520, 0, 1340, 512), 800, 16 / 10, 6.5),
    'card-newtab': ('dervishes-with-instruments-rijksmuseum-rp-f-00-6419.jpg', (0, 40, 640, 440), 800, 16 / 10, 6.5),
    'card-local': ('tortoise-trainer-osman-hamdi-1906.jpg', (0, 0, 1200, 750), 800, 16 / 10, 6.5),
    'card-open': ('dancing-dervishes-istanbul-rijksmuseum-rp-f-f01141-ch.jpg', (0, 0, 980, 612), 800, 16 / 10, 6.5),
}
# Tone curves (black point, white point, gamma): the two big figures are pushed
# harder, so their backgrounds fall away into the page colour.
FIGURE_CURVE = (.2, .92, 1.35)
CARD_CURVE = (.18, .93, 1.2)


def load(file, box, width, aspect):
    """The crop `box` of `file`, cut to `aspect` if given and resized to `width`."""
    l, t, r, b = box
    if aspect:
        w, h = r - l, b - t
        if w / h > aspect:  # too wide: trim the sides
            cut = (w - h * aspect) / 2
            l, r = l + cut, r - cut
        else:  # too tall: trim the bottom (faces are near the top)
            b = t + w / aspect
    im = Image.open(os.path.join(SRC, file)).convert('RGB').crop((round(l), round(t), round(r), round(b)))
    height = round(width * im.height / im.width)
    return np.asarray(im.resize((width, height), Image.LANCZOS)).astype(np.float32) / 255


def vignette(h, w, inner, outer, cx=.5, cy=.42):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((x / w - cx) / .5) ** 2 + ((y / h - cy) / .55) ** 2)
    return np.clip((outer - d) / (outer - inner), 0, 1) ** 1.4


def halftone(rgb, cell, curve, focus=None, angle=45):
    gray = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(6, 6))
    gray = clahe.apply((gray * 255).astype(np.uint8)).astype(np.float32) / 255
    black, white, gamma = curve
    gray = np.clip((gray - black) / (white - black), 0, 1) ** gamma
    if focus is not None:
        gray *= focus

    # Screen at three times the size and shrink, for smooth dot edges.
    k = 3
    h, w = gray.shape
    big = np.clip(cv2.resize(gray, (w * k, h * k), interpolation=cv2.INTER_CUBIC), 0, 1)
    y, x = np.mgrid[0:h * k, 0:w * k].astype(np.float32)
    a = math.radians(angle)
    u = (x * math.cos(a) + y * math.sin(a)) / (cell * k)
    v = (-x * math.sin(a) + y * math.cos(a)) / (cell * k)
    du, dv = u - np.round(u), v - np.round(v)
    radius = np.sqrt(big / math.pi) * 1.13  # dot area follows the tone
    dots = (np.sqrt(du * du + dv * dv) < radius).astype(np.float32)
    cover = cv2.resize(dots, (w, h), interpolation=cv2.INTER_AREA)

    # gold in the mid tones, parchment in the lights
    mix = gray[..., None] ** 2
    ink = np.array(GOLD, np.float32) * (1 - mix) + np.array(PARCHMENT, np.float32) * mix
    return np.dstack([ink, cover * 255]).clip(0, 255).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    for slot, (file, box, width, aspect, cell) in SLOTS.items():
        rgb = load(file, box, width, aspect)
        h, w = rgb.shape[:2]
        figure = slot in ('hero', 'way')
        focus = vignette(h, w, .45, 1.0 if slot == 'way' else 1.1) if figure else None
        rgba = halftone(rgb, cell, FIGURE_CURVE if figure else CARD_CURVE, focus)
        path = os.path.join(OUT, f'{slot}.webp')
        Image.fromarray(rgba, 'RGBA').save(path, 'WEBP', quality=82, alpha_quality=90, method=6)
        print(f'{os.path.relpath(path, ROOT)}: {w}x{h}, {os.path.getsize(path) // 1024} KB')


if __name__ == '__main__':
    main()
