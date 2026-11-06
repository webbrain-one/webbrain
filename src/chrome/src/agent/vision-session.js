// Browser-free state of the screen as the model has seen it in vision mode.
// Shared verbatim by the Chrome and Firefox builds (test/vision-mode.mjs).
//
// Every image the model receives gets an id: f<n> for a full frame
// (keyframe), p<n> for a patch of changed pixels, z<n> for a zoomed crop.
// Each id carries the affine map from its own pixels to the keyframe's
// pixels; the keyframe carries the map to CSS pixels. The model reports a
// point in whatever image it read it from and WebBrain does the arithmetic —
// device pixel ratio, browser zoom and downscaling never reach the model.
//
// The session also remembers which keyframe areas changed after each image
// was shown, so a point read from an image whose area has since changed is
// refused instead of clicking whatever moved there.

import { copyRegions, diffFrames, pointTouchesRegions } from './vision-diff.js';

export const VISION_COORDINATE_FORMATS = Object.freeze(['pixel', 'normalized']);
export const NORMALIZED_COORDINATE_SCALE = 1000;
// A point within this many keyframe pixels of a changed area is stale.
const STALE_MARGIN_PX = 4;
// A change this close to (keyframe px) inside an area known to change on its
// own still counts as that area's own change.
const AMBIENT_MARGIN_PX = 16;
const MAX_AMBIENT_REGIONS = 8;
const IMAGE_ID_RE = /^[fpz][1-9]\d{0,5}$/;

function roundTo(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function contains(area, region, margin = 0) {
  return region.x >= area.x - margin && region.y >= area.y - margin
    && region.x + region.width <= area.x + area.width + margin
    && region.y + region.height <= area.y + area.height + margin;
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

export function normalizeImageId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return IMAGE_ID_RE.test(id) ? id : '';
}

// Zooms of the current frame kept usable and in the request; older ones are
// retired (VisionSession.registerZoom, vision-runtime.js pruneVisionImages).
export const VISION_MAX_LIVE_ZOOMS = 4;

export class VisionSession {
  /**
   * `startEpoch` / `startCounter` continue the numbering of an earlier
   * session of the same conversation (another model, a restarted worker), so
   * ids and epochs never repeat within one history.
   */
  constructor({ coordinates = 'pixel', startEpoch = 0, startCounter = 0 } = {}) {
    this.coordinates = VISION_COORDINATE_FORMATS.includes(coordinates) ? coordinates : 'pixel';
    this.counter = Math.max(0, Math.floor(finite(startCounter) || 0));
    this.epoch = Math.max(0, Math.floor(finite(startEpoch) || 0));
    this.updateSeq = 0;
    this.keyframe = null;
    this.images = new Map();
    this.retired = new Map();
    this.changes = [];
    this.patchChainLength = 0;
    this.seenPixels = null;
    this.forceKeyframe = false;
    // The last screen update (or a re-check capture) failed: what the model
    // last saw may no longer be the screen, until the next frame, patch or
    // "no visible change" (vision-runtime.js gates points and typing on it).
    this.observationFailed = false;
    // Where the screen the model last saw was scrolled (keyframe, patch or
    // "no visible change"), and whether the page has scrolled since
    // (vision-runtime.js _visionStaleLayoutRefusal): its points are then
    // re-checked against the live screen.
    this.observedScroll = null;
    this.screenMoved = false;
    this.pendingZooms = [];
    // Bumped each time the model is shown a screen that differs from the one
    // it saw (a patch, a new page or layout, a frame with other pixels), never
    // for "no visible change" or a requested frame of the same screen. Loop
    // detection (vision-runtime.js _loopScreenIdentity) uses it to tell an
    // action repeated on an unchanged screen from the same action after the
    // screen moved on.
    this.screenVersion = 0;
    // The same for clicks, without the changes the page makes on its own: a
    // video or animation that went on changing while nothing acted on the
    // page (an update after a batch that only looked, such as
    // take_screenshot or wait) is left out from then on. With a video playing
    // in a feed behind a dialog, every update was a new screen and a click
    // missing the same button ten times never added up to a loop.
    this.clickScreenVersion = 0;
    this.ambientRegions = [];
    this.lastChange = null;
  }

  get hasKeyframe() {
    return !!this.keyframe;
  }

  _nextId(prefix) {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  /**
   * Start a new epoch from a full frame. Older images stop resolving.
   * `pixels` is the RGBA buffer of exactly imageWidth x imageHeight.
   * `unchanged`: the frame shows the screen the model already saw (a
   * take_screenshot of an unchanged page), so the screen version stays.
   */
  registerKeyframe(meta = {}, pixels = null, { unchanged = false, lookedOnly = false } = {}) {
    const imageWidth = Math.max(1, Math.round(finite(meta.imageWidth) || 1));
    const imageHeight = Math.max(1, Math.round(finite(meta.imageHeight) || 1));
    const cssWidth = Math.max(1, finite(meta.cssWidth) || imageWidth);
    const cssHeight = Math.max(1, finite(meta.cssHeight) || imageHeight);
    for (const [id, image] of this.images) this.retired.set(id, { epoch: image.epoch, replacedBy: null });
    if (this.retired.size > 64) {
      const drop = [...this.retired.keys()].slice(0, this.retired.size - 64);
      for (const id of drop) this.retired.delete(id);
    }
    this.epoch += 1;
    this.updateSeq += 1;
    if (!unchanged || !this.keyframe) {
      this.screenVersion += 1;
      this._noteChange(this._keyframeChange({ imageWidth, imageHeight, cssWidth, cssHeight, meta }, pixels), lookedOnly);
    } else {
      this.lastChange = [];
    }
    this.images = new Map();
    this.changes = [];
    this.patchChainLength = 0;
    this.forceKeyframe = false;
    this.observationFailed = false;
    this.screenMoved = false;
    this.observedScroll = { x: finite(meta.scrollX) || 0, y: finite(meta.scrollY) || 0 };
    const id = this._nextId('f');
    for (const retired of this.retired.values()) if (!retired.replacedBy) retired.replacedBy = id;
    this.keyframe = {
      id,
      kind: 'key',
      epoch: this.epoch,
      seq: this.updateSeq,
      width: imageWidth,
      height: imageHeight,
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      cssWidth,
      cssHeight,
      cssPerPxX: cssWidth / imageWidth,
      cssPerPxY: cssHeight / imageHeight,
      devicePixelRatio: finite(meta.devicePixelRatio) || 1,
      scrollX: finite(meta.scrollX) || 0,
      scrollY: finite(meta.scrollY) || 0,
      url: String(meta.url || ''),
      capturedAt: Number(meta.capturedAt) || Date.now(),
    };
    this.images.set(id, this.keyframe);
    this.seenPixels = pixels ? new Uint8ClampedArray(pixels) : null;
    return this.keyframe;
  }

  /**
   * Forget the current screen (a new run starts, or the screen can no longer
   * be trusted): its images become "from an earlier screen" and coordinate
   * tools are refused until the next keyframe.
   */
  retireKeyframe() {
    for (const [id, image] of this.images) this.retired.set(id, { epoch: image.epoch, replacedBy: null });
    this.images = new Map();
    this.keyframe = null;
    this.seenPixels = null;
    this.changes = [];
    this.patchChainLength = 0;
    this.pendingZooms = [];
    this.forceKeyframe = true;
  }

  /**
   * Record patches (keyframe px regions) the model is about to receive.
   * `lookedOnly`: the update follows a batch that did not act on the page.
   */
  registerPatches(regions = [], pixels = null, { lookedOnly = false } = {}) {
    if (!this.keyframe) throw new Error('A keyframe is required before patches.');
    this.updateSeq += 1;
    this.observationFailed = false;
    if (regions.length) {
      this.screenVersion += 1;
      this._noteChange(regions.map(region => ({ x: region.x, y: region.y, width: region.width, height: region.height })), lookedOnly);
    }
    const seq = this.updateSeq;
    const images = regions.map(region => {
      const id = this._nextId('p');
      const image = {
        id,
        kind: 'patch',
        epoch: this.epoch,
        seq,
        width: Math.round(region.width),
        height: Math.round(region.height),
        offsetX: Math.round(region.x),
        offsetY: Math.round(region.y),
        scaleX: 1,
        scaleY: 1,
      };
      this.images.set(id, image);
      return image;
    });
    this.changes.push({ seq, regions: regions.map(region => ({ x: region.x, y: region.y, width: region.width, height: region.height })) });
    this.patchChainLength += 1;
    if (pixels && this.seenPixels && this.seenPixels.length === pixels.length) {
      copyRegions(this.seenPixels, pixels, this.keyframe.width, regions);
    }
    return images;
  }

  /** The model was told nothing visible changed; the seen frame stays. */
  registerNoChange() {
    if (!this.keyframe) return;
    this.updateSeq += 1;
    this.observationFailed = false;
    this.lastChange = [];
  }

  /**
   * What a new keyframe changed against the screen the model saw before it:
   * its changed regions when both show the same page, layout and scroll, or
   * null (everything) when they cannot be compared.
   */
  _keyframeChange({ imageWidth, imageHeight, cssWidth, cssHeight, meta }, pixels) {
    const previous = this.keyframe;
    if (!previous || !this.seenPixels || !pixels || previous.width !== imageWidth || previous.height !== imageHeight
        || previous.cssWidth !== cssWidth || previous.cssHeight !== cssHeight
        || previous.scrollX !== (finite(meta.scrollX) || 0) || previous.scrollY !== (finite(meta.scrollY) || 0)
        || previous.url !== String(meta.url || '')) return null;
    const diff = diffFrames(this.seenPixels, pixels, imageWidth, imageHeight);
    return diff.comparable ? diff.regions.map(region => ({ x: region.x, y: region.y, width: region.width, height: region.height })) : null;
  }

  /**
   * One screen update's change (keyframe px regions; null for another page,
   * layout or scroll) for clickScreenVersion. An area that changed while
   * nothing acted on the page, and had changed in the update before too,
   * changes on its own: its later changes are not a new screen for a click.
   * Any other change is (a click's effect can show up anywhere: a counter
   * beside its button, the next slide, a delayed result).
   */
  _noteChange(regions, lookedOnly) {
    const previous = this.lastChange;
    this.lastChange = regions;
    if (!regions) {
      this.ambientRegions = [];
      this.clickScreenVersion += 1;
      return;
    }
    if (!regions.length) return;
    const ambient = region => this.ambientRegions.some(area => contains(area, region, AMBIENT_MARGIN_PX));
    const recurring = region => Array.isArray(previous) && previous.some(earlier => overlaps(earlier, region));
    let changed = false;
    for (const region of regions) {
      if (ambient(region)) continue;
      if (lookedOnly && recurring(region)) {
        this.ambientRegions.push(region);
        if (this.ambientRegions.length > MAX_AMBIENT_REGIONS) this.ambientRegions.shift();
        continue;
      }
      changed = true;
    }
    if (changed) this.clickScreenVersion += 1;
  }

  /** A patch or "no visible change" was read at this scroll position. */
  noteObservedScroll(scrollX, scrollY) {
    this.observedScroll = { x: finite(scrollX) || 0, y: finite(scrollY) || 0 };
    this.screenMoved = false;
  }

  /**
   * Register a zoomed crop. `region` is in keyframe px; `width`/`height` are
   * the crop image's own pixels.
   */
  registerZoom(region, width, height) {
    if (!this.keyframe) throw new Error('A keyframe is required before zooming.');
    const id = this._nextId('z');
    const image = {
      id,
      kind: 'zoom',
      epoch: this.epoch,
      seq: this.updateSeq,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      offsetX: region.x,
      offsetY: region.y,
      scaleX: region.width / Math.max(1, width),
      scaleY: region.height / Math.max(1, height),
    };
    this.images.set(id, image);
    // Only the newest zooms stay usable, as only they stay in the model's
    // request (vision-runtime.js pruneVisionImages): an older one is retired.
    const zooms = [...this.images.values()].filter(item => item.kind === 'zoom');
    for (const old of zooms.slice(0, Math.max(0, zooms.length - VISION_MAX_LIVE_ZOOMS))) {
      this.images.delete(old.id);
      this.retired.set(old.id, { epoch: old.epoch, replacedBy: null, zoomLimit: true });
    }
    return image;
  }

  /**
   * A zoom taken after earlier actions of its batch shows the screen those
   * actions left, which the update after the batch then reports as changed
   * (patches newer than the zoom). That update found `changedSince` (frame
   * px regions) changed after the zoom's capture: the zoom becomes as
   * current as the update and stays stale only there.
   */
  markZoomCurrent(id, changedSince = []) {
    const image = this.images.get(id);
    if (image?.kind !== 'zoom' || image.epoch !== this.epoch) return false;
    image.seq = this.updateSeq;
    image.staleRegions = (changedSince || []).map(region => ({ x: region.x, y: region.y, width: region.width, height: region.height }));
    return true;
  }

  /** Should the next observation be a full frame regardless of the diff? */
  needsKeyframe(meta = {}) {
    return this.forceKeyframe || this.layoutChanged(meta);
  }

  /**
   * Does `meta` describe another page, viewport or scale than the current
   * keyframe (or is there no frame to compare with)? A requested frame
   * (forceKeyframe) of the same layout is not a layout change.
   */
  layoutChanged(meta = {}) {
    if (!this.keyframe || !this.seenPixels) return true;
    const k = this.keyframe;
    const differs = (a, b, tolerance = 0.5) => Math.abs((finite(a) || 0) - (finite(b) || 0)) > tolerance;
    if (differs(meta.cssWidth, k.cssWidth) || differs(meta.cssHeight, k.cssHeight)) return true;
    if (differs(meta.devicePixelRatio, k.devicePixelRatio, 0.01)) return true;
    if (meta.url != null && String(meta.url) !== k.url) return true;
    return false;
  }

  _imageFor(imageId) {
    const raw = imageId == null ? '' : String(imageId).trim();
    // No image named: the current screen. A value that is not an image id
    // ("zoom z2", "z2.png") is refused rather than read as the current screen,
    // which would map a zoom's point through the keyframe.
    if (!raw) return { image: this.keyframe, id: this.keyframe?.id || '', composite: true };
    const id = normalizeImageId(raw);
    if (!id) return { image: null, id: raw.slice(0, 40), retired: null };
    const image = this.images.get(id);
    if (image) return { image, id, composite: false };
    return { image: null, id, retired: this.retired.get(id) || null };
  }

  /**
   * Convert a model point into CSS pixels of the current viewport.
   * `image` names the image the point was read from; omitted means the
   * current screen as the model has seen it (latest frame plus patches).
   */
  resolvePoint({ x, y, image } = {}) {
    if (!this.keyframe) {
      return { ok: false, code: 'no_frame', error: 'No screenshot of this page has been taken yet. Call take_screenshot, then use coordinates from that image.' };
    }
    const lookup = this._imageFor(image);
    if (!lookup.image) {
      if (lookup.retired) {
        return { ok: false, code: 'stale_image', error: lookup.retired.zoomLimit
          ? `Zoom ${lookup.id} is no longer shown: only the newest ${VISION_MAX_LIVE_ZOOMS} zooms are kept. Read the point from the current frame ${this.keyframe.id}, or zoom again.`
          : `Image ${lookup.id} is from an earlier screen. The current full frame is ${this.keyframe.id}; read the point from it or from a later patch.` };
      }
      return { ok: false, code: 'unknown_image', error: `Unknown image "${lookup.id}". Name an image exactly as labeled (valid now: ${[...this.images.keys()].join(', ')}), or omit image for the current screen.` };
    }
    const target = lookup.image;
    const px = finite(x);
    const py = finite(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return { ok: false, code: 'invalid_point', error: 'x and y must be numbers.' };
    }
    let ix = px;
    let iy = py;
    if (this.coordinates === 'normalized') {
      if (px < 0 || py < 0 || px > NORMALIZED_COORDINATE_SCALE || py > NORMALIZED_COORDINATE_SCALE) {
        return { ok: false, code: 'out_of_bounds', error: `(${px}, ${py}) is outside 0..${NORMALIZED_COORDINATE_SCALE}. Coordinates are normalized to 0..${NORMALIZED_COORDINATE_SCALE} of ${target.id}.` };
      }
      ix = (px / NORMALIZED_COORDINATE_SCALE) * target.width;
      iy = (py / NORMALIZED_COORDINATE_SCALE) * target.height;
    } else if (px < 0 || py < 0 || px > target.width || py > target.height) {
      return { ok: false, code: 'out_of_bounds', error: `(${px}, ${py}) is outside ${target.id}, which is ${target.width}x${target.height} pixels.` };
    }
    const kx = Math.min(this.keyframe.width - 0.5, target.offsetX + Math.min(ix, target.width - 0.5) * target.scaleX);
    const ky = Math.min(this.keyframe.height - 0.5, target.offsetY + Math.min(iy, target.height - 0.5) * target.scaleY);
    if (!lookup.composite) {
      const later = [...this.changes.filter(change => change.seq > target.seq).flatMap(change => change.regions), ...(target.staleRegions || [])];
      if (pointTouchesRegions({ x: kx, y: ky }, later, STALE_MARGIN_PX)) {
        const newest = [...this.images.values()].filter(img => img.kind === 'patch' && img.seq > target.seq)
          .find(img => pointTouchesRegions({ x: kx, y: ky }, [{ x: img.offsetX, y: img.offsetY, width: img.width, height: img.height }], STALE_MARGIN_PX));
        return { ok: false, code: 'stale_area', error: `The area around that point changed after ${target.id} was taken${newest ? ` (see ${newest.id})` : ''}. Read the point from the newest image.` };
      }
    }
    const cssX = Math.min(this.keyframe.cssWidth - 0.5, Math.max(0, kx * this.keyframe.cssPerPxX));
    const cssY = Math.min(this.keyframe.cssHeight - 0.5, Math.max(0, ky * this.keyframe.cssPerPxY));
    return {
      ok: true,
      imageId: target.id,
      keyframeId: this.keyframe.id,
      keyframePoint: { x: roundTo(kx), y: roundTo(ky) },
      cssX: roundTo(cssX),
      cssY: roundTo(cssY),
    };
  }

  /** Resolve a rectangle {x, y, width, height} (zoom). */
  resolveRegion({ x, y, width, height, image } = {}) {
    const w = finite(width);
    const h = finite(height);
    if (!(w > 0) || !(h > 0)) return { ok: false, code: 'invalid_region', error: 'width and height must be positive.' };
    const topLeft = this.resolvePoint({ x, y, image });
    if (!topLeft.ok) return topLeft;
    const lookup = this._imageFor(image);
    const target = lookup.image;
    let bx = finite(x) + w;
    let by = finite(y) + h;
    if (this.coordinates === 'normalized') {
      bx = Math.min(bx, NORMALIZED_COORDINATE_SCALE);
      by = Math.min(by, NORMALIZED_COORDINATE_SCALE);
    } else {
      bx = Math.min(bx, target.width);
      by = Math.min(by, target.height);
    }
    const bottomRight = this.resolvePoint({ x: bx, y: by, image });
    if (!bottomRight.ok && bottomRight.code !== 'stale_area') return bottomRight;
    const k0 = topLeft.keyframePoint;
    // The rectangle's size in the target image's own pixels (normalized
    // coordinates are 0..1000 of that image).
    const wImage = this.coordinates === 'normalized' ? (w / NORMALIZED_COORDINATE_SCALE) * target.width : w;
    const hImage = this.coordinates === 'normalized' ? (h / NORMALIZED_COORDINATE_SCALE) * target.height : h;
    const k1 = bottomRight.ok ? bottomRight.keyframePoint : {
      x: Math.min(this.keyframe.width, k0.x + wImage * target.scaleX),
      y: Math.min(this.keyframe.height, k0.y + hImage * target.scaleY),
    };
    const kfRegion = {
      x: Math.max(0, Math.floor(k0.x)),
      y: Math.max(0, Math.floor(k0.y)),
      width: Math.max(1, Math.ceil(k1.x - k0.x)),
      height: Math.max(1, Math.ceil(k1.y - k0.y)),
    };
    return {
      ok: true,
      keyframeRegion: kfRegion,
      cssRegion: {
        x: roundTo(kfRegion.x * this.keyframe.cssPerPxX),
        y: roundTo(kfRegion.y * this.keyframe.cssPerPxY),
        width: roundTo(kfRegion.width * this.keyframe.cssPerPxX),
        height: roundTo(kfRegion.height * this.keyframe.cssPerPxY),
      },
    };
  }

  /** CSS point → keyframe pixel (for stability checks on later frames). */
  cssToKeyframe(cssX, cssY) {
    if (!this.keyframe) return null;
    return { x: cssX / this.keyframe.cssPerPxX, y: cssY / this.keyframe.cssPerPxY };
  }

  /** Ids whose images are still worth keeping in the model's context. */
  liveImageIds() {
    return new Set(this.images.keys());
  }

  coordinateHint() {
    return this.coordinates === 'normalized'
      ? `x,y are normalized 0..${NORMALIZED_COORDINATE_SCALE} across the image you read them from`
      : 'x,y are pixels of the image you read them from, origin top-left';
  }

  /** Short, trusted description of a keyframe for the model. */
  describeKeyframe(frame = this.keyframe) {
    if (!frame) return '';
    const ratio = frame.cssPerPxX;
    return `${frame.id}: full viewport, ${frame.width}x${frame.height} image (1 image px = ${roundTo(ratio, 2)} CSS px)`;
  }
}
