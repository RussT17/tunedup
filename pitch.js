// Pitch detection: normalised square difference function (McLeod / MPM),
// computed via FFT so it stays cheap enough for a phone.
//
// The NSDF is  n(t) = 2 * r(t) / m(t)  where r(t) is the autocorrelation at
// lag t and m(t) is the summed power of the two overlapping windows. Peaks of
// n(t) sit at multiples of the period; picking the *first* peak that is nearly
// as tall as the tallest one is what keeps us off the octave above/below.

const MIN_FREQ = 27.5;   // A0
const MAX_FREQ = 2100;   // ~C7
const CLARITY_THRESHOLD = 0.55;
const PEAK_RATIO = 0.9;

/** Iterative in-place radix-2 FFT. `inverse` skips the 1/N scaling (unneeded here). */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = uRe + vRe;       im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe; im[i + k + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export class PitchDetector {
  constructor(windowSize) {
    this.size = windowSize;
    this.fftSize = 1;
    while (this.fftSize < windowSize * 2) this.fftSize <<= 1;
    this.re = new Float32Array(this.fftSize);
    this.im = new Float32Array(this.fftSize);
    this.nsdf = new Float32Array(windowSize);
    this.cumPower = new Float64Array(windowSize + 1);
    this.work = new Float32Array(windowSize);
  }

  /**
   * @returns {{frequency:number, clarity:number, rms:number}} — frequency is 0
   * when nothing convincing was found.
   */
  detect(input, sampleRate) {
    const n = this.size;
    const x = this.work;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += input[i];
    mean /= n;

    let power = 0;
    this.cumPower[0] = 0;
    for (let i = 0; i < n; i++) {
      const v = input[i] - mean;
      x[i] = v;
      power += v * v;
      this.cumPower[i + 1] = power;
    }
    const rms = Math.sqrt(power / n);
    if (rms < 0.004) return { frequency: 0, clarity: 0, rms };

    // Autocorrelation via the Wiener–Khinchin theorem.
    const m = this.fftSize;
    this.re.fill(0);
    this.im.fill(0);
    this.re.set(x.subarray(0, n));
    fft(this.re, this.im, false);
    for (let i = 0; i < m; i++) {
      this.re[i] = this.re[i] * this.re[i] + this.im[i] * this.im[i];
      this.im[i] = 0;
    }
    fft(this.re, this.im, true);
    const scale = 1 / m;

    const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    const maxLag = Math.min(n - 2, Math.ceil(sampleRate / MIN_FREQ));
    const nsdf = this.nsdf;
    const total = this.cumPower[n];
    for (let t = minLag; t <= maxLag; t++) {
      const divisor = this.cumPower[n - t] + total - this.cumPower[t];
      nsdf[t] = divisor > 0 ? (2 * this.re[t] * scale) / divisor : 0;
    }

    // Collect the highest point of each positive hump, then take the first one
    // that reaches PEAK_RATIO of the tallest hump.
    let bestLag = -1, bestValue = -1;
    let peakLag = -1, peakValue = -1;
    let inHump = false;
    const peaks = [];
    for (let t = minLag + 1; t <= maxLag; t++) {
      const prev = nsdf[t - 1], cur = nsdf[t];
      if (!inHump && prev <= 0 && cur > 0) { inHump = true; peakLag = t; peakValue = cur; }
      else if (inHump) {
        if (cur > peakValue) { peakValue = cur; peakLag = t; }
        if (cur <= 0) {
          inHump = false;
          peaks.push(peakLag);
          if (peakValue > bestValue) { bestValue = peakValue; bestLag = peakLag; }
        }
      }
    }
    if (inHump && peakLag > 0) {
      peaks.push(peakLag);
      if (peakValue > bestValue) { bestValue = peakValue; bestLag = peakLag; }
    }
    if (bestLag < 0 || bestValue < CLARITY_THRESHOLD) return { frequency: 0, clarity: 0, rms };

    const threshold = bestValue * PEAK_RATIO;
    let chosen = bestLag;
    for (const p of peaks) {
      if (nsdf[p] >= threshold) { chosen = p; break; }
    }

    // Parabolic interpolation for sub-sample (sub-cent) lag precision.
    const y0 = nsdf[chosen - 1], y1 = nsdf[chosen], y2 = nsdf[chosen + 1];
    const denom = 2 * (2 * y1 - y0 - y2);
    const shift = denom !== 0 ? (y2 - y0) / denom : 0;
    const lag = chosen + Math.max(-1, Math.min(1, shift));
    const frequency = sampleRate / lag;
    if (frequency < MIN_FREQ || frequency > MAX_FREQ) return { frequency: 0, clarity: 0, rms };

    return { frequency, clarity: Math.min(1, y1), rms };
  }
}
