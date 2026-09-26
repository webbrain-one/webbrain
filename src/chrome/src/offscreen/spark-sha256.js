// Streaming SHA-256 avoids materializing the nearly 4 GB external weights in a
// single ArrayBuffer (which exceeds Chromium's typed-array size limit).
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (x, n) => (x >>> n) | (x << (32 - n));

export class SparkSha256 {
  constructor() {
    this.state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.pending = new Uint8Array(64);
    this.pendingView = new DataView(this.pending.buffer);
    this.words = new Uint32Array(64);
    this.used = 0;
    this.bytes = 0;
    this.finished = false;
  }
  block(view, offset) {
    const w = this.words;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3))
        + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
    }
    const state = this.state;
    let a = state[0], b = state[1], c = state[2], d = state[3];
    let e = state[4], f = state[5], g = state[6], h = state[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25))
        + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22))
        + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    // Avoid allocating arrays/callbacks per 64-byte block of a 4 GB download.
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  update(data) {
    if (this.finished) throw new Error('SHA-256 already finalized.');
    this.bytes += data.byteLength;
    let offset = 0;
    if (this.used) {
      const take = Math.min(64 - this.used, data.length);
      this.pending.set(data.subarray(0, take), this.used);
      this.used += take;
      offset = take;
      if (this.used === 64) { this.block(this.pendingView, 0); this.used = 0; }
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (; offset + 64 <= data.length; offset += 64) this.block(view, offset);
    if (offset < data.length) {
      this.pending.set(data.subarray(offset), 0);
      this.used = data.length - offset;
    }
    return this;
  }
  hex() {
    if (this.finished) throw new Error('SHA-256 already finalized.');
    const bits = this.bytes * 8;
    const padding = new Uint8Array(this.used < 56 ? 64 - this.used : 128 - this.used);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padding.length - 4, bits >>> 0);
    this.update(padding);
    this.finished = true;
    return [...this.state].map(x => x.toString(16).padStart(8, '0')).join('');
  }
}
