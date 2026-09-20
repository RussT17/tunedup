// Pitch detection: normalised square difference function (McLeod / MPM),
// computed via FFT so it stays cheap enough for a phone.
//
// The NSDF is  n(t) = 2 * r(t) / m(t)  where r(t) is the autocorrelation at
// lag t and m(t) is the summed power of the two overlapping windows. Peaks of
// n(t) sit at multiples of the period; picking the *first* peak that is nearly
// as tall as the tallest one is what keeps us off the octave above/below.

const DEFAULT_MIN_FREQ = 65;    // below the lowest guitar string; room rumble lives here
const DEFAULT_MAX_FREQ = 1400;
const CLARITY_THRESHOLD = 0.55;
const PEAK_RATIO = 0.9;

/** Iterative in-place radix-2 FFT. `inverse` skips the 1/N scaling (unneeded here). */
export function fft(re, im, inverse) {
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
  detect(input, sampleRate, options = {}) {
    const {
      minRms = 0.004,
      minFreq = DEFAULT_MIN_FREQ,
      maxFreq = DEFAULT_MAX_FREQ,
      room = null,
      learnRoom = false,
    } = typeof options === 'number' ? { minRms: options } : options;
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
    // A silent room is below any sensible pitch threshold, and silence is
    // exactly what a room profile needs to measure — so when learning, the
    // level gate is skipped and the spectrum is taken anyway.
    if (rms < minRms && !(room && learnRoom)) return { frequency: 0, clarity: 0, rms };

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

    let retained = 1;
    if (room) {
      const bins = m >> 1;
      if (learnRoom) {
        room.observe(this.re.subarray(0, bins));
        if (rms < minRms) return { frequency: 0, clarity: 0, rms };
      } else if (room.ready) {
        // Keep only the bands carrying more than this room's own noise. The
        // autocorrelation then sees the note and not the fridge — without
        // excluding any frequency in advance, so a genuine low note is kept
        // exactly where a steady rumble is dropped.
        let before = 0;
        let after = 0;
        for (let i = 1; i < bins; i++) {
          const value = this.re[i];
          before += value;
          if (room.admits(i, value)) after += value;
          else this.re[i] = this.re[m - i] = 0;
        }
        if (before > 0) retained = after / before;
        if (retained < 0.02) return { frequency: 0, clarity: 0, rms };
      }
    }

    fft(this.re, this.im, true);
    const scale = 1 / m;

    const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    const maxLag = Math.min(n - 2, Math.ceil(sampleRate / minFreq));
    const nsdf = this.nsdf;
    const total = this.cumPower[n];
    for (let t = minLag; t <= maxLag; t++) {
      // m(t) is measured on the unfiltered signal, so scale it by the share of
      // power the gate kept. Peak positions do not care; the clarity value does.
      const divisor = (this.cumPower[n - t] + total - this.cumPower[t]) * retained;
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
    if (frequency < minFreq || frequency > maxFreq) return { frequency: 0, clarity: 0, rms };

    return { frequency, clarity: Math.min(1, y1), rms };
  }
}

/**
 * Interpolated magnitude spectrum of the newest `size` samples, Hann windowed.
 * Used to pick which partial to track and to measure string inharmonicity.
 */
export function spectrum(input, size) {
  let fftSize = 1;
  while (fftSize < size) fftSize <<= 1;
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let i = 0; i < size; i++) {
    re[i] = input[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  fft(re, im, false);
  const bins = fftSize >> 1;
  const magnitude = new Float32Array(bins);
  for (let i = 0; i < bins; i++) magnitude[i] = Math.hypot(re[i], im[i]);
  return { magnitude, fftSize };
}

/**
 * Refines the spectral peak nearest `target` (Hz) by parabolic interpolation on
 * the log magnitudes. Returns null when there is no peak worth naming.
 */
export function refinePeak(magnitude, fftSize, sampleRate, target, searchBins = 4) {
  const centre = Math.round((target * fftSize) / sampleRate);
  if (centre < 2 || centre >= magnitude.length - 2) return null;
  let peak = centre;
  for (let i = centre - searchBins; i <= centre + searchBins; i++) {
    if (i > 0 && i < magnitude.length && magnitude[i] > magnitude[peak]) peak = i;
  }
  if (peak < 1 || peak >= magnitude.length - 1) return null;
  const a = Math.log(magnitude[peak - 1] + 1e-12);
  const b = Math.log(magnitude[peak] + 1e-12);
  const c = Math.log(magnitude[peak + 1] + 1e-12);
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  const bin = peak + Math.max(-1, Math.min(1, shift));

  // Local noise estimate: median of the surrounding bins, away from the peak.
  const neighbourhood = [];
  for (let i = peak - 24; i <= peak + 24; i++) {
    if (i > 0 && i < magnitude.length && Math.abs(i - peak) > 3) neighbourhood.push(magnitude[i]);
  }
  neighbourhood.sort((x, y) => x - y);
  const floor = neighbourhood.length ? neighbourhood[neighbourhood.length >> 1] : 1e-9;

  return {
    frequency: (bin * sampleRate) / fftSize,
    amplitude: magnitude[peak],
    snr: magnitude[peak] / (floor + 1e-12),
  };
}
