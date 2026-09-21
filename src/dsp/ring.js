// Ring buffer over absolute sample indices (DESIGN §4).
//
// The absolute index exists to be USED: any gap, device change, sample-rate
// change, route change or backgrounding shows up as an index discontinuity and
// must reset the phase accumulator, the partial tracker and the envelope fit.
// Without that the tuner silently reports garbage after a headphone is
// unplugged.

export class Ring {
  constructor(capacity) {
    this.cap = 1 << Math.ceil(Math.log2(capacity));
    this.mask = this.cap - 1;
    this.buf = new Float32Array(this.cap);
    this.end = 0;                 // absolute index one past the newest sample
  }
  get first() { return Math.max(0, this.end - this.cap); }
  get last() { return this.end; }
  at(i) { return this.buf[i & this.mask]; }
  write(chunk) {
    for (let i = 0; i < chunk.length; i++) this.buf[(this.end + i) & this.mask] = chunk[i];
    this.end += chunk.length;
  }
  reset() { this.buf.fill(0); this.end = 0; }
}

// Second-order high-pass at 20 Hz for DC and subsonic handling noise, and
// nothing else. It runs STREAMING on ingest, once per sample: a second-order
// IIR carries state, so running it per analysis frame would either re-filter
// the same samples with the wrong state or produce a discontinuity at every
// frame boundary -- and §7.2's path is time-domain, so it needs the real
// filter rather than a zeroed bin. Room noise is handled in the frequency
// domain (§5); a fixed high-pass placed above the noise necessarily also
// excludes notes.
export class DCBlocker {
  constructor(sampleRate, cutoff = 20) {
    const w = Math.tan((Math.PI * cutoff) / sampleRate);
    const q = Math.SQRT1_2;
    const n = 1 / (1 + w / q + w * w);
    this.b0 = n; this.b1 = -2 * n; this.b2 = n;
    this.a1 = 2 * (w * w - 1) * n;
    this.a2 = (1 - w / q + w * w) * n;
    this.z1 = 0; this.z2 = 0;
  }
  process(buf) {
    const { b0, b1, b2, a1, a2 } = this;
    let z1 = this.z1, z2 = this.z2;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
}
