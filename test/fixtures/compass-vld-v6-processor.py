"""Processor reference for test/fixtures/compass-vld-v6-processor.json: Lfm3VlImageProcessor
(image_processing_lfm3_vl.py) for deterministic synthetic images. The resize is Pillow's
BICUBIC (torch's uint8 antialiased bicubic reproduces its integer pipeline), the
normalization transformers' fused (x - 127.5) / 127.5, then the model's patchify."""
import hashlib, json, math
import numpy as np
from PIL import Image

PATCH, MERGE, TEMPORAL = 16, 2, 2
def smart_resize(h, w, factor=32, min_pixels=65536, max_pixels=16777216):
    if max(h, w) / min(h, w) > 200: raise ValueError('aspect')
    h_bar = round(h / factor) * factor; w_bar = round(w / factor) * factor
    if h_bar * w_bar > max_pixels:
        beta = math.sqrt((h * w) / max_pixels)
        h_bar = max(factor, math.floor(h / beta / factor) * factor); w_bar = max(factor, math.floor(w / beta / factor) * factor)
    elif h_bar * w_bar < min_pixels:
        beta = math.sqrt(min_pixels / (h * w))
        h_bar = math.ceil(h * beta / factor) * factor; w_bar = math.ceil(w * beta / factor) * factor
    return h_bar, w_bar

def synthetic(w, h, seed):
    # The same generator as the JS test: a gradient with a checkerboard and seeded noise.
    out = np.zeros((h, w, 3), np.uint8)
    state = seed
    for y in range(h):
        for x in range(w):
            state = (state * 1103515245 + 12345) & 0x7fffffff
            n = state % 37
            out[y, x, 0] = (x * 255 // max(1, w - 1) + n) % 256
            out[y, x, 1] = (y * 255 // max(1, h - 1) + 2 * n) % 256
            out[y, x, 2] = (((x // 7 + y // 5) % 2) * 200 + n) % 256
    return out

def process(rgb):
    h, w = rgb.shape[:2]
    rh, rw = smart_resize(h, w)
    img = Image.fromarray(rgb, 'RGB')
    if (rw, rh) != (w, h): img = img.resize((rw, rh), Image.BICUBIC)
    x = np.asarray(img, np.uint8)
    lut = ((np.arange(256, dtype=np.float32) - np.float32(127.5)) / np.float32(127.5)).astype(np.float32)
    x = lut[x].transpose(2, 0, 1)[None]
    gh, gw = rh // PATCH, rw // PATCH
    p = x.reshape(1, 3, gh // MERGE, MERGE, PATCH, gw // MERGE, MERGE, PATCH).transpose(0, 2, 5, 3, 6, 1, 4, 7)
    p = np.broadcast_to(p[:, :, :, :, :, :, None], (1, gh // MERGE, gw // MERGE, MERGE, MERGE, 3, TEMPORAL, PATCH, PATCH))
    p = np.ascontiguousarray(p, dtype=np.float32).reshape(-1)
    return rh, rw, gh, gw, p

cases = []
for (w, h, seed) in [(96, 60, 1), (333, 517, 2), (640, 352, 3), (1281, 721, 4)]:
    rgb = synthetic(w, h, seed)
    rh, rw, gh, gw, p = process(rgb)
    cases.append({
        'width': w, 'height': h, 'seed': seed,
        'resized': [rh, rw], 'grid': [gh, gw], 'tokens': gh * gw // 4, 'values': int(p.size),
        'sha256': hashlib.sha256(p.tobytes()).hexdigest(),
        'head': [float(v) for v in p[:8]], 'sample': [[int(i), float(p[i])] for i in np.linspace(0, p.size - 1, 12).astype(int)],
    })
resize_table = [[h, w, *smart_resize(h, w)] for h, w in [(720, 1280), (1080, 1920), (100, 100), (60, 96), (517, 333), (4000, 6000), (8000, 8000), (225, 400)]]
json.dump({'cases': cases, 'smartResize': resize_table}, open('fixture/compass-vld-v6-processor.json', 'w'), indent=1)
print(json.dumps(resize_table)); print([(c['width'], c['height'], c['resized'], c['tokens']) for c in cases])
