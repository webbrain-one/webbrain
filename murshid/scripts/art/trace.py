"""Trace public-domain pictures into line-art SVGs for the Murshid homepage.

    pip install opencv-python-headless numpy scipy scikit-image
    python scripts/art/trace.py [portrait|semazen|all] [--debug=DIR]

Writes assets/art/murshid-portrait.svg, assets/art/murshid-portrait-crimson.svg
and assets/art/semazen.svg. The sources and their licences are listed in
scripts/art/sources/README.md.

How it works, per picture:
  1. crop the figure and smooth the paint flat (mean shift + median);
  2. label every pixel with the nearest of a few reference colours, sampled
     from the source at the points in CONFIG. Gold patterning and dark pleats
     are "noise" and are absorbed into whatever surrounds them, and hand-placed
     boxes say where a colour may count (skin only on the face and hands...);
  3. majority-filter the labels (garments coarsely, so their patterns vanish;
     faces, hands and turbans finely), drop specks and absorb small islands;
  4. draw the outline of every region once (shared edges are not doubled);
  5. add the artist's own fine lines (turban folds, eyes, pleats) found with a
     ridge filter, thinned to centre lines that run on through junctions;
  6. smooth, simplify and write everything as cubic Bezier strokes, each
     starting at its top and sorted top to bottom, so the page can draw the
     picture downward.
"""

import os
import sys

import cv2
import numpy as np
from scipy import ndimage
from skimage.filters import apply_hysteresis_threshold, sato
from skimage.morphology import skeletonize

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

# Reference colours are sampled (median of a small window, after smoothing) at
# these points of the full source image. role: 'figure' regions are outlined;
# 'ground' regions are outlined faintly; 'noise' pixels are given to their
# neighbours; anything else is background.
CONFIG = {
    'portrait': {
        'src': 'sources/suleiman-nakkas-osman-1579.jpg',
        'crop': (80, 345, 1040, 1785),
        'work_width': 960,
        'out': 'assets/art/murshid-portrait.svg',
        'variants': {'assets/art/murshid-portrait-crimson.svg': 'crimson'},
        'out_width': 600,
        'credit': 'Suleiman the Magnificent, traced from the portrait by Nakkas Osman, 1579 '
                  '(Topkapi Palace Museum, H.1563 fol. 47v). Public domain.',
        'classes': {
            'turban': {'role': 'figure', 'fine': True, 'pts': [(650, 590), (560, 520), (740, 680), (640, 470)],
                       'boxes': [(440, 380, 860, 880)]},
            'tuft': {'role': 'figure', 'fine': True, 'keep': True, 'pts': [(700, 405)], 'boxes': [(630, 360, 770, 460)]},
            'skin': {'role': 'figure', 'fine': True, 'keep': True, 'pts': [(668, 790), (535, 1120), (860, 1470), (700, 800)],
                     'boxes': [(500, 700, 740, 930), (440, 1020, 620, 1200), (760, 1360, 960, 1580)]},
            'beard': {'role': 'figure', 'fine': True, 'keep': True, 'pts': [(625, 860), (600, 830)], 'boxes': [(500, 760, 720, 960)]},
            'caftan': {'role': 'figure', 'pts': [(360, 1410), (760, 1610), (510, 960), (300, 1500), (840, 1560)]},
            'blue': {'role': 'figure', 'pts': [(625, 1060), (300, 1010), (880, 1080), (640, 1500)], 'min_area': 2500},
            'sleeve': {'role': 'figure', 'pts': [(360, 1190), (880, 1260), (420, 1170)], 'min_area': 2500},
            'white': {'role': 'figure', 'keep': True, 'pts': [(640, 1320), (530, 1650)], 'min_area': 400,
                      'boxes': [(550, 1270, 690, 1370), (440, 1540, 620, 1700), (220, 1650, 960, 1745)]},
            'lavender': {'role': 'bg', 'pts': [(260, 560), (910, 660), (300, 800), (850, 820)]},
            'frame': {'role': 'bg', 'pts': [(105, 660), (1000, 660)]},
            'throne': {'role': 'ground', 'pts': [(180, 1010), (940, 960), (160, 1100)],
                       'boxes': [(60, 820, 1020, 1225)], 'min_area': 6000},
            'pink': {'role': 'bg', 'pts': [(140, 1320), (1000, 1400), (900, 1760)]},
            'green': {'role': 'bg', 'pts': [(890, 1380)]},
            'gold': {'role': 'noise', 'lab': [(150, 134, 179), (165, 130, 170), (128, 136, 168)]},
        },
        'figure_box': (104, 370, 1014, 1772),
        'majority': 6,
        'coarse': 18,
        'island': 5000,
        'min_area': 260,
        'details': [
            # the painter's fold lines in the turban
            {'regions': ['turban'], 'sigmas': (1.5, 2.5), 'low': 0.009, 'high': 0.024, 'min_len': 70, 'erode': 7},
            # brows, eyes and nose, drawn before the region outlines can claim them
            {'name': 'face', 'box': (630, 742, 720, 834), 'upscale': 4, 'sigmas': (.75, 1.25, 1.75),
             'low': 0.03, 'high': 0.07, 'min_len': 6, 'erode': 0, 'smooth': 0.6, 'first': True},
            {'regions': ['skin'], 'sigmas': (1, 2), 'low': 0.04, 'high': 0.09, 'min_len': 12, 'erode': 3},
        ],
        'smooth': 2.2,
        'simplify': 0.9,
        'min_len': 26,
    },
    'semazen': {
        'src': 'sources/semazen-mevlevi-lithograph-bm-1904-0929-59.jpg',
        'crop': (130, 110, 1110, 1400),
        'work_width': 980,
        'out': 'assets/art/semazen.svg',
        'out_width': 560,
        'credit': 'A Mevlevi dervish, traced from a hand-coloured lithograph, about 1830-60 '
                  '(British Museum 1904,0929.59). Public domain.',
        'classes': {
            'sikke': {'role': 'figure', 'fine': True, 'keep': True, 'pts': [(580, 260), (620, 330), (540, 230)],
                      'boxes': [(470, 180, 690, 180, 690, 338, 545, 386, 470, 386)]},
            'skin': {'role': 'figure', 'fine': True, 'keep': True,
                     'pts': [(580, 400), (260, 185), (1040, 622), (600, 1330)],
                     'boxes': [(535, 390, 690, 342, 690, 465, 535, 465), (200, 130, 340, 240), (990, 590, 1105, 655),
                               (540, 1270, 670, 1380)]},
            'beard': {'role': 'figure', 'fine': True, 'keep': True, 'pts': [(640, 420), (625, 440)],
                      'boxes': [(590, 360, 680, 470)]},
            'jacket': {'role': 'figure', 'pts': [(420, 400), (700, 620), (900, 600)], 'boxes': [(150, 120, 1010, 715)]},
            'shirt': {'role': 'figure', 'keep': True, 'pts': [(640, 500)], 'boxes': [(580, 440, 710, 580)]},
            'sash': {'role': 'noise', 'pts': [(600, 682)]},
            'skirt': {'role': 'figure', 'pts': [(500, 900), (800, 1000), (350, 1100), (650, 1200), (700, 1050)]},
            'pleat': {'role': 'noise', 'lab': [(88, 103, 155), (45, 111, 148), (60, 108, 150)]},
            'cream': {'role': 'bg', 'pts': [(180, 400), (200, 800)]},
            'yellow': {'role': 'bg', 'pts': [(950, 380), (1060, 850)]},
            'floor': {'role': 'bg', 'pts': [(160, 1150), (1060, 1150), (300, 1360), (850, 1330), (420, 1290)]},
        },
        'figure_box': (150, 120, 1105, 1395),
        'majority': 5,
        'coarse': 12,
        'island': 4000,
        'min_area': 300,
        'details': [
            # hands, face and feet: the lithographer's own contour lines, upscaled
            {'name': 'hand-l', 'box': (200, 128, 345, 252), 'upscale': 3, 'sigmas': (.75, 1.25), 'low': 0.035,
             'high': 0.08, 'min_len': 12, 'erode': -8, 'smooth': 0.8, 'first': True, 'claim': True, 'layer': 'main'},
            {'name': 'hand-r', 'box': (985, 585, 1108, 662), 'upscale': 3, 'sigmas': (.75, 1.25), 'low': 0.035,
             'high': 0.08, 'min_len': 12, 'erode': -8, 'smooth': 0.8, 'first': True, 'claim': True, 'layer': 'main'},
            {'name': 'face', 'box': (545, 338, 688, 470), 'upscale': 3, 'sigmas': (.75, 1.25), 'low': 0.035,
             'high': 0.08, 'min_len': 9, 'erode': -4, 'smooth': 0.8, 'first': True, 'claim': True},
            {'name': 'feet', 'box': (505, 1262, 700, 1395), 'upscale': 3, 'sigmas': (.75, 1.25), 'low': 0.035,
             'high': 0.08, 'min_len': 12, 'erode': -6, 'smooth': 0.8, 'first': True, 'claim': True, 'layer': 'main'},
            # the dark pleats of the skirt, as centre lines
            {'regions': ['skirt'], 'sigmas': (3, 5), 'low': 0.04, 'high': 0.09, 'min_len': 60, 'erode': 4},
            # folds of the jacket
            {'regions': ['jacket'], 'sigmas': (2, 3), 'low': 0.05, 'high': 0.1, 'min_len': 30, 'erode': 5},
        ],
        'smooth': 2.2,
        'simplify': 0.9,
        'min_len': 26,
    },
}


# ---------------------------------------------------------------- utilities

def lab_of(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)


def smooth_paint(img):
    sm = cv2.pyrMeanShiftFiltering(img, 8, 22)
    return cv2.medianBlur(sm, 5)


def fill_unknown(labels, unknown):
    """Give each unknown pixel the label of the nearest known pixel."""
    if not unknown.any():
        return labels
    _, (iy, ix) = ndimage.distance_transform_edt(unknown, return_indices=True)
    return labels[iy, ix]


def majority(labels, n, radius):
    """Mode filter: each pixel takes the most common label around it."""
    if radius <= 0:
        return labels
    k = radius * 2 + 1
    best = np.full(labels.shape, -1.0, np.float32)
    out = labels.copy()
    for i in range(n):
        score = cv2.GaussianBlur((labels == i).astype(np.float32), (k, k), radius / 2)
        win = score > best
        out[win] = i
        best[win] = score[win]
    return out


def drop_specks(labels, n, min_area):
    unknown = np.zeros(labels.shape, bool)
    for i in range(n):
        count, comp, stats, _ = cv2.connectedComponentsWithStats((labels == i).astype(np.uint8), connectivity=4)
        small = np.where(stats[1:, cv2.CC_STAT_AREA] < min_area[i])[0] + 1
        if len(small):
            unknown |= np.isin(comp, small)
    return fill_unknown(labels, unknown)


def absorb_islands(labels, n, max_area, keep, purity=0.6):
    """Small regions wholly inside another region become part of it."""
    for i in range(n):
        if i in keep:
            continue
        cnt, comp, stats, _ = cv2.connectedComponentsWithStats((labels == i).astype(np.uint8), connectivity=4)
        for c in range(1, cnt):
            x, y, w, h, area = stats[c]
            if area >= max_area:
                continue
            ys, xs = slice(max(0, y - 3), y + h + 3), slice(max(0, x - 3), x + w + 3)
            sub = comp[ys, xs] == c
            ring = cv2.dilate(sub.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & ~sub
            vals = labels[ys, xs][ring]
            if not len(vals):
                continue
            counts = np.bincount(vals, minlength=n)
            j = int(np.argmax(counts))
            if j != i and counts[j] >= purity * len(vals):
                labels[ys, xs][sub] = j
    return labels


def gauss_smooth(pts, sigma, closed):
    if sigma <= 0 or len(pts) < 5:
        return pts.astype(np.float32)
    mode = 'wrap' if closed else 'nearest'
    x = ndimage.gaussian_filter1d(pts[:, 0].astype(np.float32), sigma, mode=mode)
    y = ndimage.gaussian_filter1d(pts[:, 1].astype(np.float32), sigma, mode=mode)
    out = np.stack([x, y], 1)
    if not closed:  # keep the ends where they were
        out[0], out[-1] = pts[0], pts[-1]
    return out


def simplify(pts, eps, closed):
    if len(pts) < 3:
        return pts
    approx = cv2.approxPolyDP(pts.reshape(-1, 1, 2).astype(np.float32), eps, closed)
    return approx.reshape(-1, 2)


def poly_len(pts):
    return float(np.sum(np.hypot(*np.diff(pts, axis=0).T))) if len(pts) > 1 else 0.0


def trace_skeleton(sk, spur=8):
    """Walk a one-pixel skeleton into polylines (arrays of (x, y)).

    Junction pixels are grouped into nodes; short dead-end spurs are pruned;
    at each junction the two branches that continue most straight are joined,
    so a line keeps going through the places where something touches it.
    """
    ys, xs = np.nonzero(sk)
    on = set(zip(ys.tolist(), xs.tolist()))
    offs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    nb = {p: [(p[0] + dy, p[1] + dx) for dy, dx in offs if (p[0] + dy, p[1] + dx) in on] for p in on}

    node_of = {}
    for p in on:  # junction pixels that touch form one node; every end is a node
        if len(nb[p]) != 2 and p not in node_of:
            nid = len(set(node_of.values()))
            node_of[p] = nid
            stack = [p] if len(nb[p]) > 2 else []
            while stack:
                q = stack.pop()
                for r in nb[q]:
                    if len(nb[r]) > 2 and r not in node_of:
                        node_of[r] = nid
                        stack.append(r)

    edges = {}  # id -> [node a, node b, [pixels]]
    seen = set()
    pairs = set()
    for p, na in list(node_of.items()):
        for q in nb[p]:
            if q in node_of:
                nq = node_of[q]
                if nq != na and (min(na, nq), max(na, nq)) not in pairs:
                    pairs.add((min(na, nq), max(na, nq)))
                    edges[len(edges)] = [na, nq, [p, q]]
                continue
            if q in seen:
                continue
            path, prev, cur = [p, q], p, q
            seen.add(q)
            end = None
            while True:
                nxt = [r for r in nb[cur] if r != prev]
                if not nxt:
                    break
                r = nxt[0]
                if r in node_of:
                    path.append(r)
                    end = node_of[r]
                    break
                if r in seen:
                    break
                seen.add(r)
                path.append(r)
                prev, cur = cur, r
            edges[len(edges)] = [na, end if end is not None else -1 - len(edges), path]
    loops = []
    for p in on:  # rings with no node at all
        if p not in node_of and p not in seen:
            path, prev, cur = [p], None, p
            seen.add(p)
            while True:
                nxt = [r for r in nb[cur] if r != prev and r not in seen]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                seen.add(cur)
                path.append(cur)
            loops.append(path)

    def degree():
        d = {}
        for a, b, _ in edges.values():
            d[a] = d.get(a, 0) + 1
            d[b] = d.get(b, 0) + 1
        return d

    changed = True
    while changed:  # prune short dead ends hanging off junctions
        changed = False
        d = degree()
        for eid, (a, b, px) in list(edges.items()):
            if len(px) < spur and ((d.get(a) == 1 and d.get(b, 0) >= 3) or (d.get(b) == 1 and d.get(a, 0) >= 3)):
                del edges[eid]
                changed = True
                break

    # at each node, pair the edge ends that continue most straight
    ends = {}
    for eid, (a, b, px) in edges.items():
        ends.setdefault(a, []).append((eid, 0))
        ends.setdefault(b, []).append((eid, 1))

    def direction(eid, side):
        px = edges[eid][2] if side == 0 else edges[eid][2][::-1]
        far = px[min(len(px) - 1, 8)]
        v = np.array([far[1] - px[0][1], far[0] - px[0][0]], np.float32)
        return v / (np.linalg.norm(v) + 1e-6)

    link = {}
    for node, lst in ends.items():
        free = list(lst)
        while len(free) >= 2:
            best, pair = -0.2, None  # only join if they continue (angle > ~100 degrees)
            for i in range(len(free)):
                for j in range(i + 1, len(free)):
                    if free[i][0] == free[j][0]:
                        continue
                    c = -float(direction(*free[i]) @ direction(*free[j]))
                    if c > best:
                        best, pair = c, (free[i], free[j])
            if not pair:
                break
            link[pair[0]] = pair[1]
            link[pair[1]] = pair[0]
            free.remove(pair[0]); free.remove(pair[1])

    used, out = set(), []

    def chain(eid, side):
        """Follow edges from end (eid, side) onward; returns pixel list."""
        px = []
        while eid is not None and eid not in used:
            used.add(eid)
            seg = edges[eid][2] if side == 0 else edges[eid][2][::-1]
            px.extend(seg if not px else seg[1:])
            nxt = link.get((eid, 1 - side))
            eid, side = (nxt[0], nxt[1]) if nxt else (None, None)
        return px

    for eid in list(edges):
        if eid in used:
            continue
        # start from an end that is not linked, so the chain is walked from its start
        if (eid, 0) not in link:
            out.append(chain(eid, 0))
        elif (eid, 1) not in link:
            out.append(chain(eid, 1))
    for eid in list(edges):  # closed chains
        if eid not in used:
            out.append(chain(eid, 0))
    out.extend(loops)
    return [np.array([(x, y) for y, x in path], np.float32) for path in out if len(path) > 1]


class Drawn:
    """Remembers what has been drawn, so shared edges are drawn once."""

    def __init__(self, shape, width):
        self.mask = np.zeros(shape, np.uint8)
        self.width = width

    def fresh_runs(self, pts, closed, min_len):
        h, w = self.mask.shape
        xi = np.clip(np.round(pts[:, 0]).astype(int), 0, w - 1)
        yi = np.clip(np.round(pts[:, 1]).astype(int), 0, h - 1)
        free = self.mask[yi, xi] == 0
        if free.all():
            return [(pts, closed)] if poly_len(pts) >= min_len else []
        if closed:  # start at a covered point so no run wraps around
            start = int(np.argmin(free))
            pts, free = np.roll(pts, -start, 0), np.roll(free, -start)
        runs, cur = [], []
        for p, f in zip(pts, free):
            if f:
                cur.append(p)
            elif cur:
                runs.append(np.array(cur)); cur = []
        if cur:
            runs.append(np.array(cur))
        return [(r, False) for r in runs if poly_len(r) >= min_len]

    def add(self, pts, closed):
        cv2.polylines(self.mask, [np.round(pts).astype(np.int32).reshape(-1, 1, 2)], closed, 255, self.width)


def catmull_rom_path(pts, closed, scale, prec=1):
    """Cubic Bezier path through the points (relative commands, rounded)."""
    p = pts * scale
    n = len(p)
    def f(v):
        s = '%.*f' % (prec, v)
        if '.' in s:
            s = s.rstrip('0').rstrip('.')
        if s in ('-0', ''):
            return '0'
        if s.startswith('0.'):
            return s[1:]
        if s.startswith('-0.'):
            return '-' + s[2:]
        return s
    if n < 2:
        return ''
    get = (lambda i: p[i % n]) if closed else (lambda i: p[min(max(i, 0), n - 1)])
    segs = n if closed else n - 1
    d = [f'M{f(p[0][0])} {f(p[0][1])}']
    cur = p[0].copy()
    for i in range(segs):
        p0, p1, p2, p3 = get(i - 1), get(i), get(i + 1), get(i + 2)
        c1 = p1 + (p2 - p0) / 6
        c2 = p2 - (p3 - p1) / 6
        vals = [c1 - cur, c2 - cur, p2 - cur]
        d.append('c' + ' '.join(f'{f(v[0])} {f(v[1])}' for v in vals).replace(' -', '-'))
        cur = cur + np.round(vals[2], prec)
    if closed:
        d.append('z')
    return ''.join(d)


# ----------------------------------------------------------------- tracing

def classify(cfg, img_full, sm, crop, k):
    x0, y0 = crop[0], crop[1]
    lab = lab_of(sm)
    names, refs = [], []
    for name, c in cfg['classes'].items():
        for pt in c.get('pts', []):
            x, y = int((pt[0] - x0) * k), int((pt[1] - y0) * k)
            win = lab[max(0, y - 4):y + 5, max(0, x - 4):x + 5].reshape(-1, 3)
            refs.append(np.median(win, 0)); names.append(name)
        for v in c.get('lab', []):
            refs.append(np.array(v, np.float32)); names.append(name)
    refs = np.array(refs, np.float32)
    uniq = list(cfg['classes'].keys())
    ref_cls = np.array([uniq.index(n) for n in names])
    # weight lightness a little less than colour
    wts = np.array([0.7, 1.0, 1.0], np.float32)
    best = np.full(sm.shape[:2], np.inf, np.float32)
    labels = np.zeros(sm.shape[:2], np.int32)
    for ref, cls in zip(refs, ref_cls):
        dist = (((lab - ref) * wts) ** 2).sum(-1)
        win = dist < best
        labels[win] = cls
        best[win] = dist[win]
    return labels, uniq


def trace(name, debug=None):
    cfg = CONFIG[name]
    img_full = cv2.imread(os.path.join(HERE, cfg['src']))
    x0, y0, x1, y1 = cfg['crop']
    img = img_full[y0:y1, x0:x1]
    k = cfg['work_width'] / img.shape[1]
    img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC)
    sm = smooth_paint(img)
    labels, uniq = classify(cfg, img_full, sm, cfg['crop'], k)
    n = len(uniq)
    roles = [cfg['classes'][u]['role'] for u in uniq]
    noise = np.isin(labels, [i for i, r in enumerate(roles) if r == 'noise'])
    yy, xx = np.mgrid[0:labels.shape[0], 0:labels.shape[1]]
    sx, sy = xx / k + x0, yy / k + y0  # source coordinates of every pixel
    def inside(b):
        """Pixels inside a hint: (x0, y0, x1, y1) or a polygon (x, y, x, y, ...), source coords."""
        if len(b) == 4:
            return (sx >= b[0]) & (sx <= b[2]) & (sy >= b[1]) & (sy <= b[3])
        poly = ((np.array(b, np.float32).reshape(-1, 2) - [x0, y0]) * k).round().astype(np.int32)
        m = np.zeros(sx.shape, np.uint8)
        cv2.fillPoly(m, [poly], 1)
        return m > 0
    for i, u in enumerate(uniq):
        boxes = cfg['classes'][u].get('boxes')
        if boxes:  # hand-placed hints: this colour only counts inside these boxes
            allowed = np.zeros(labels.shape, bool)
            for b in boxes:
                allowed |= inside(b)
            noise |= (labels == i) & ~allowed
    labels = fill_unknown(labels, noise)
    fine_ids = [i for i, u in enumerate(uniq) if cfg['classes'][u].get('fine')]
    fine = majority(labels, n, cfg['majority'])
    # garments are smoothed at a coarse scale (their patterns vanish); faces,
    # hands and turbans keep the fine scale
    coarse = fill_unknown(labels, np.isin(labels, fine_ids))
    coarse = majority(coarse, n, cfg.get('coarse', cfg['majority']))
    is_fine = np.isin(fine, fine_ids)
    labels = np.where(is_fine, fine, coarse)
    labels = drop_specks(labels, n, [cfg['classes'][u].get('min_area', cfg['min_area']) for u in uniq])
    labels = majority(labels, n, max(2, cfg['majority'] // 2))
    keep = [i for i, u in enumerate(uniq) if cfg['classes'][u].get('keep')]
    for _ in range(2 if cfg.get('island') else 0):  # twice, for islands that touch each other
        labels = absorb_islands(labels, n, cfg['island'], keep)

    if debug:
        os.makedirs(debug, exist_ok=True)
        pal = np.array([np.median(sm[labels == i], 0) if (labels == i).any() else (0, 0, 0) for i in range(n)], np.uint8)
        vis = pal[labels]
        edges = cv2.morphologyEx(labels.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
        vis[edges] = 0
        src = sm.copy()
        for c in cfg['classes'].values():
            for pt in c.get('pts', []):
                cv2.circle(src, (int((pt[0] - cfg['crop'][0]) * k), int((pt[1] - cfg['crop'][1]) * k)), 6, (0, 255, 0), 2)
        for i, u in enumerate(uniq):
            cv2.putText(vis, u, (10, 30 + i * 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 3)
            cv2.putText(vis, u, (10, 30 + i * 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8, pal[i].tolist(), 2)
        cv2.imwrite(os.path.join(debug, f'{name}-labels.png'), np.hstack([src, vis]))
        print({u: int((labels == i).sum()) for i, u in enumerate(uniq)})

    h, w = labels.shape
    sigma, eps, min_len = cfg['smooth'], cfg['simplify'], cfg['min_len']
    drawn = Drawn((h, w), 5)
    strokes = []  # (layer, pts, closed)

    def outline(mask, layer):
        mask = cv2.morphologyEx(mask.astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        cs, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        for c in cs:
            pts = gauss_smooth(c.reshape(-1, 2), sigma, True)
            if poly_len(pts) < min_len:
                continue
            for run, closed in drawn.fresh_runs(pts, True, min_len):
                strokes.append((layer, run, closed))
                drawn.add(run, closed)

    fig_ids = [i for i, r in enumerate(roles) if r == 'figure']
    ground_ids = [i for i, r in enumerate(roles) if r == 'ground']
    figure = np.isin(labels, fig_ids)
    fb = cfg.get('figure_box')
    if fb:
        figure &= inside(fb)
        # where the box cuts the figure, leave it open rather than ruling a line
        cut = np.round([(fb[0] - x0) * k, (fb[1] - y0) * k, (fb[2] - x0) * k, (fb[3] - y0) * k]).astype(int)
        cv2.rectangle(drawn.mask, (cut[0], cut[1]), (cut[2], cut[3]), 255, 7)
    # the figure is the biggest connected blob of figure colours
    cnt, comp, stats, _ = cv2.connectedComponentsWithStats(figure.astype(np.uint8), connectivity=8)
    if cnt > 1:
        biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        figure = comp == biggest
        figure = ndimage.binary_fill_holes(figure)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255

    def detail(det):
        region = np.isin(labels, [uniq.index(r) for r in det.get('regions', uniq)]) & figure
        e = det.get('erode', 3)
        if e > 0:
            region = cv2.erode(region.astype(np.uint8), np.ones((e * 2 + 1,) * 2, np.uint8)) > 0
        elif e < 0:  # reach a little past the region, for lines drawn on its edge
            region = cv2.dilate(region.astype(np.uint8), np.ones((-e * 2 + 1,) * 2, np.uint8)) > 0
        # work inside the bounding box of the region (or the given box), upscaled
        # so small features (eyes, brows) thin into smooth centre lines
        if det.get('box'):
            b = det['box']
            bx0, by0 = max(0, int((b[0] - x0) * k)), max(0, int((b[1] - y0) * k))
            bx1, by1 = min(w, int((b[2] - x0) * k)), min(h, int((b[3] - y0) * k))
        else:
            ys, xs = np.nonzero(region)
            bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        u = det.get('upscale', 1)
        sub = cv2.resize(img[by0:by1, bx0:bx1], None, fx=u, fy=u, interpolation=cv2.INTER_CUBIC)
        g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
        ridge = sato(g, sigmas=[sg * u for sg in det.get('sigmas', (1, 2))], black_ridges=True)
        mask = cv2.resize(region[by0:by1, bx0:bx1].astype(np.uint8), (sub.shape[1], sub.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
        ridge[~mask] = 0
        lines = apply_hysteresis_threshold(ridge, det['low'], det['high'])
        if debug:
            cv2.imwrite(os.path.join(debug, f"{name}-detail-{det.get('name', det.get('regions', ['all'])[0])}.png"),
                        np.hstack([g * 255, (ridge * 255 / max(1e-6, ridge.max())), lines * 255.0]).astype(np.uint8))
        for path in trace_skeleton(skeletonize(lines)):
            path = path / u + np.array([bx0, by0], np.float32)
            if poly_len(path) < det['min_len']:
                continue
            pts = gauss_smooth(path, det.get('smooth', sigma * 0.8), False)
            for run, closed in drawn.fresh_runs(pts, False, det['min_len']):
                strokes.append((det.get('layer', 'fine'), run, closed))
                drawn.add(run, closed)
        if det.get('claim'):  # region outlines stay out of this box
            drawn.mask[by0:by1, bx0:bx1] = 255

    for det in cfg['details']:
        if det.get('first'):
            detail(det)
    outline(figure, 'main')
    for i in fig_ids:
        outline((labels == i) & figure, 'main')
    for i in ground_ids:
        outline((labels == i) & ~figure, 'ground')
    for det in cfg['details']:
        if not det.get('first'):
            detail(det)

    return cfg, (w, h), strokes


STYLE = {
    'main': 'stroke-width:1.9',
    'fine': 'stroke-width:1.15;opacity:.9',
    'ground': 'stroke-width:.9;opacity:.35',
}


def write_svg(name, cfg, size, strokes, out=None, background=None):
    w, h = size
    scale = cfg['out_width'] / w
    W, H = cfg['out_width'], round(h * scale)
    layers = {}
    for layer, pts, closed in strokes:
        pts = simplify(pts, cfg['simplify'], closed)
        if len(pts) < 2:
            continue
        # every stroke starts at its top, so the page draws the picture downward
        if closed:
            pts = np.roll(pts, -int(np.argmin(pts[:, 1])), 0)
        elif pts[-1, 1] < pts[0, 1]:
            pts = pts[::-1]
        top = float(pts[:, 1].min())
        layers.setdefault(layer, []).append((top, catmull_rom_path(pts, closed, scale)))
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
             'fill="none" stroke-linecap="round" stroke-linejoin="round">',
             f'<desc>{cfg["credit"]}</desc>',
             # colours can be set from the page when the drawing is inlined
             '<style>.ln{stroke:var(--line,#f0cd7e)}.ln-fine{stroke:var(--line-fine,var(--line,#f0cd7e))}'
             '.ln-ground{stroke:var(--line-ground,#f4ead6)}</style>']
    if background:
        parts.append(background(W, H))
    for layer in ('ground', 'main', 'fine'):
        if layer not in layers:
            continue
        paths = ''.join(f'<path d="{d}"/>' for _, d in sorted(layers[layer]))
        parts.append(f'<g class="ln ln-{layer}" style="{STYLE[layer]}">{paths}</g>')
    parts.append('</svg>')
    svg = ''.join(parts)
    path = os.path.join(ROOT, out or cfg['out'])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(svg + '\n')
    print(f'{os.path.relpath(path, ROOT)}  {len(svg) // 1024} KB  {sum(len(v) for v in layers.values())} strokes')


def crimson(W, H):
    """The arch's crimson ground, for a version of the portrait that stands alone."""
    return ('<defs><radialGradient id="g" cx=".54" cy=".32" r=".8"><stop offset="0" stop-color="#b3202f"/>'
            '<stop offset=".5" stop-color="#9e1b2b"/><stop offset="1" stop-color="#6c0f1d"/></radialGradient></defs>'
            f'<rect width="{W}" height="{H}" fill="url(#g)"/>')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    which = args[0] if args else 'all'
    names = list(CONFIG) if which == 'all' else [which]
    for name in names:
        cfg, size, strokes = trace(name, opts.get('debug'))
        write_svg(name, cfg, size, strokes)
        for out, bg in cfg.get('variants', {}).items():
            write_svg(name, cfg, size, strokes, out=out, background=globals()[bg])


if __name__ == '__main__':
    main()
