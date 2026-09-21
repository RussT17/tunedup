// Acquisition: which note is this? (DESIGN §7.1)
//
// Needs robustness to a missing fundamental, immunity to octave errors, and
// only about +-20 cents of accuracy. It does NOT need to be precise -- §7.2
// does that -- and conflating the two jobs is what produced both the octave
// errors and the silent wrong-turn failures in the prototype.
//
// The method is McLeod's NSDF computed on the ROOM-GATED signal:
//
//     n(tau) = 2 r(tau) / m(tau),   m(tau) = sum( x[j]^2 + x[j+tau]^2 )
//
// m(tau) is a running sum over time-domain samples and cannot be taken from a
// gated spectrum. Computing r spectrally while taking m from the ungated signal
// leaves n unbounded and, worse, reinstates the ACF's (1 - tau/N) taper, which
// biases lag selection toward SHORT lags -- that is, toward octave-UP errors,
// which §2.3's missing fundamental already makes the likely failure. So both
// terms come from the same gated signal: one inverse transform gives x~, and
// everything else is built from it.

import { FFT } from './fft.js';
import { hann } from './window.js';
import { MIN_F0, MAX_F0 } from './notes.js';

const LP_HZ = 5500;        // above this contributes nothing to a <=700 Hz pitch
const TARGET_RATE = 12000; // decimate to here before correlating

export class Acquirer {
  constructor(frameSize, sampleRate) {
    this.N = frameSize;
    this.sampleRate = sampleRate;
    this.M = frameSize * 2;               // zero-pad to avoid circular wraparound
    this.fft = new FFT(this.M);
    this.win = hann(frameSize);

    this.decim = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
    this.rate = sampleRate / this.decim;
    this.minLag = Math.max(2, Math.floor(this.rate / MAX_F0) - 1);
    this.maxLag = Math.ceil(this.rate / MIN_F0) + 1;

    this.re = new Float64Array(this.M);
    this.im = new Float64Array(this.M);
    this.gain = new Float64Array(this.M / 2 + 1);
    this.dec = new Float64Array(Math.ceil(frameSize / this.decim) + 1);
    this.prefix = new Float64Array(this.dec.length + 1);
    this.nsdf = new Float64Array(this.maxLag + 2);
  }

  // frame: frameSize samples. noise: per-bin room power on the MONITOR spectrum
  // grid (frameSize/2+1 bins). scale converts monitor-window power to this
  // window's power -- exact for white noise, close enough for coloured.
  run(frame, { noise, alpha, scale = 1 }) {
    const { N, M, re, im, win, gain } = this;
    for (let i = 0; i < N; i++) re[i] = frame[i] * win[i];
    re.fill(0, N);
    im.fill(0);
    this.fft.forward(re, im);

    // Soft gain, not a binary mask: a hard 0/1 mask rings, and this signal is
    // about to be autocorrelated, where ringing becomes a spurious period. The
    // gain reaches zero exactly at the admission threshold, so it is continuous
    // with the hard mask used for selecting partials in §7.2.
    const half = M / 2;
    const kMax = Math.min(half, Math.floor((LP_HZ * M) / this.sampleRate));
    for (let k = 0; k <= half; k++) {
      if (k > kMax) { gain[k] = 0; continue; }
      const p = re[k] * re[k] + im[k] * im[k];
      // Monitor grid is half as fine as this padded one.
      const n = noise[Math.min(noise.length - 1, k >> 1)] * scale;
      gain[k] = p > 0 ? Math.max(0, 1 - (alpha * n) / p) : 0;
    }
    // Smooth the gain across bins so the curve has no step to ring on.
    let prev = gain[0];
    for (let k = 1; k < half; k++) {
      const v = 0.25 * prev + 0.5 * gain[k] + 0.25 * gain[k + 1];
      prev = gain[k];
      gain[k] = v;
    }
    for (let k = 0; k <= half; k++) {
      const g = gain[k];
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < half) { const j = M - k; re[j] *= g; im[j] *= g; }
    }

    this.fft.inverse(re, im);
    // Re-zero the pad. Gating is convolution in time, so the gated signal's
    // energy spreads across the whole buffer including the pad; leaving it
    // there is exactly the wraparound the pad was supposed to prevent.
    re.fill(0, N);

    // Decimate (the spectrum was low-passed above, so this cannot alias).
    const D = this.decim;
    const dn = Math.floor(N / D);
    const dec = this.dec;
    for (let i = 0; i < dn; i++) dec[i] = re[i * D];

    const prefix = this.prefix;
    prefix[0] = 0;
    for (let i = 0; i < dn; i++) prefix[i + 1] = prefix[i] + dec[i] * dec[i];
    if (prefix[dn] <= 0) return null;

    const nsdf = this.nsdf;
    const maxLag = Math.min(this.maxLag, dn - 8);
    for (let tau = this.minLag; tau <= maxLag; tau++) {
      let r = 0;
      const top = dn - tau;
      for (let j = 0; j < top; j++) r += dec[j] * dec[j + tau];
      const m = (prefix[top] - prefix[0]) + (prefix[dn] - prefix[tau]);
      nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    }

    return this._pick(nsdf, this.minLag, maxLag, dn);
  }

  // First peak reaching k * the tallest (McLeod). This defends against choosing
  // a MULTIPLE of the period -- octave-down. The normalisation above is what
  // defends against the opposite error, which is the one §2.3 makes likely.
  _pick(nsdf, lo, hi, dn) {
    let best = 0;
    const peaks = [];
    for (let tau = lo + 1; tau < hi; tau++) {
      if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1]) {
        peaks.push(tau);
        if (nsdf[tau] > best) best = nsdf[tau];
      }
    }
    if (!peaks.length || best <= 0) return null;

    const threshold = 0.9 * best;
    let chosen = -1;
    for (const tau of peaks) if (nsdf[tau] >= threshold) { chosen = tau; break; }
    if (chosen < 0) return null;

    // Parabolic interpolation for a sub-sample lag.
    const y0 = nsdf[chosen - 1], y1 = nsdf[chosen], y2 = nsdf[chosen + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const lag = chosen + Math.max(-1, Math.min(1, shift));
    const freq = this.rate / lag;
    if (!(freq >= MIN_F0 && freq <= MAX_F0)) return null;

    return { freq, clarity: y1, lag, peaks: peaks.length };
  }
}
