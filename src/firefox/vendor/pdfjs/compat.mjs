/*
 * Feature-detected polyfills for the few recent JavaScript methods that the
 * modern PDF.js build (pdf.mjs, pdf.worker.mjs) calls without a fallback.
 *
 * Upstream ships two builds. The legacy build bundles core-js, whose old
 * Internet Explorer fallbacks Chrome Web Store review rejects as obfuscated
 * code. The modern build has no polyfills at all and assumes the newest
 * browsers. We ship the modern build and fill only these gaps, which keeps
 * PDF reading working on Chrome 128+ and Firefox 140+:
 *
 *   Map/WeakMap.prototype.getOrInsert(Computed)  Chrome 145, Firefox 144
 *   Math.sumPrecise                              Chrome 147, Firefox 137
 *   Uint8Array.fromBase64, toBase64, toHex       Chrome 140, Firefox 133
 *   Response.prototype.bytes                     Chrome 132, Firefox 128
 *   Promise.try
 *
 * Each method is installed only when the browser lacks it. index.mjs loads
 * this file before pdf.mjs in the page, and worker.mjs loads it before
 * pdf.worker.mjs in the PDF.js worker, because the two realms do not share
 * built-ins.
 */

function defineMissing(target, name, value) {
  if (name in target) return;
  Object.defineProperty(target, name, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

defineMissing(Promise, 'try', function promiseTry(callback, ...args) {
  return new this((resolve) => resolve(Reflect.apply(callback, undefined, args)));
});

for (const Collection of [Map, WeakMap]) {
  defineMissing(Collection.prototype, 'getOrInsert', function getOrInsert(key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });

  defineMissing(Collection.prototype, 'getOrInsertComputed', function getOrInsertComputed(key, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('getOrInsertComputed requires a callback function');
    }
    if (this.has(key)) return this.get(key);
    const value = callback(key);
    this.set(key, value);
    return value;
  });
}

// Exactly rounded sum built from Shewchuk's non-overlapping partials, the
// same algorithm as Python's math.fsum. Intermediate overflow (finite inputs
// whose running sum exceeds Number.MAX_VALUE) is not handled; PDF.js only
// sums byte and glyph lengths.
defineMissing(Math, 'sumPrecise', function sumPrecise(items) {
  const partials = [];
  let nonFinite = 0;
  let allNegativeZero = true;

  for (const value of items) {
    if (typeof value !== 'number') {
      throw new TypeError('Math.sumPrecise expects an iterable of numbers');
    }
    if (!Object.is(value, -0)) allNegativeZero = false;
    if (!Number.isFinite(value)) {
      // NaN, or +Infinity together with -Infinity, makes the result NaN.
      nonFinite = nonFinite === 0 || nonFinite === value ? value : NaN;
      continue;
    }
    if (nonFinite !== 0) continue;

    let x = value;
    let kept = 0;
    for (let i = 0; i < partials.length; i++) {
      let y = partials[i];
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) partials[kept++] = lo;
      x = hi;
    }
    partials.length = kept;
    partials.push(x);
  }

  if (nonFinite !== 0) return nonFinite;
  if (allNegativeZero) return -0;

  let n = partials.length;
  let hi = 0;
  if (n > 0) {
    hi = partials[--n];
    let lo = 0;
    while (n > 0) {
      const x = hi;
      const y = partials[--n];
      hi = x + y;
      lo = y - (hi - x);
      if (lo !== 0) break;
    }
    // Correct round-half-even when the remaining partials tip the result
    // over a rounding boundary.
    if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
      const doubled = lo * 2;
      const rounded = hi + doubled;
      if (doubled === rounded - hi) hi = rounded;
    }
  }
  return hi;
});

// String.fromCharCode.apply has an argument-count limit, so encode in slices.
const BASE64_SLICE_BYTES = 0x8000;

defineMissing(Uint8Array.prototype, 'toBase64', function toBase64(options = {}) {
  let binary = '';
  for (let i = 0; i < this.length; i += BASE64_SLICE_BYTES) {
    binary += String.fromCharCode.apply(null, this.subarray(i, i + BASE64_SLICE_BYTES));
  }
  let base64 = btoa(binary);
  if (options.alphabet === 'base64url') base64 = base64.replace(/\+/g, '-').replace(/\//g, '_');
  if (options.omitPadding) base64 = base64.replace(/=+$/, '');
  return base64;
});

defineMissing(Uint8Array, 'fromBase64', function fromBase64(string, options = {}) {
  if (typeof string !== 'string') {
    throw new TypeError('Uint8Array.fromBase64 expects a string');
  }
  const base64 = options.alphabet === 'base64url'
    ? string.replace(/-/g, '+').replace(/_/g, '/')
    : string;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
});

defineMissing(Uint8Array.prototype, 'toHex', function toHex() {
  let hex = '';
  for (const byte of this) hex += byte.toString(16).padStart(2, '0');
  return hex;
});

if (typeof Response === 'function') {
  defineMissing(Response.prototype, 'bytes', async function bytes() {
    return new Uint8Array(await this.arrayBuffer());
  });
}
