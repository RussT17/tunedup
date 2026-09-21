// Two windows, for two different jobs (DESIGN §4).
//
//   Hann             — the phase path and the NSDF frame. Its clarity
//                      thresholds are calibrated against this taper, not
//                      inherited from McLeod's rectangular frames.
//   Blackman-Harris  — detection and masking. DESIGN §2.3 says the fundamental
//                      can sit 20 dB below the third partial, and Hann's -31 dB
//                      sidelobe from a strong partial would swamp a weak one and
//                      corrupt the mask. -92 dB buys that margin.

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function blackmanHarris(n) {
  const a = [0.35875, 0.48829, 0.14128, 0.01168];
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    w[i] = a[0] - a[1] * Math.cos(t) + a[2] * Math.cos(2 * t) - a[3] * Math.cos(3 * t);
  }
  return w;
}

// Coherent gain: sum(w)/n. Divide a windowed magnitude by this to recover the
// amplitude of a sinusoid sitting on a bin centre.
export function coherentGain(w) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s / w.length;
}
