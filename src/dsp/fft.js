// Radix-2 complex FFT, in place, with a pre-computed twiddle/bit-reversal plan.
// Pre-allocated everywhere: allocating in the analysis loop produces periodic GC
// pauses that are indistinguishable from audio dropouts (DESIGN §4).

export class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error(`FFT size ${n} is not a power of two`);
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  // In-place transform of interleaved-free split arrays.
  forward(re, im) { this._run(re, im, false); }

  inverse(re, im) {
    this._run(re, im, true);
    const s = 1 / this.n;
    for (let i = 0; i < this.n; i++) { re[i] *= s; im[i] *= s; }
  }

  _run(re, im, inv) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cos[k];
          const s = inv ? -sin[k] : sin[k];
          const l = j + half;
          const tr = re[l] * c - im[l] * s;
          const ti = re[l] * s + im[l] * c;
          re[l] = re[j] - tr; im[l] = im[j] - ti;
          re[j] += tr;        im[j] += ti;
        }
      }
    }
  }
}

// Power spectrum of a real, already-windowed frame. Returns n/2+1 bins.
export function powerSpectrum(fft, frame, re, im, out) {
  const n = fft.n;
  re.set(frame);
  im.fill(0);
  fft.forward(re, im);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}
