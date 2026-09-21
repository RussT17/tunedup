// Hypothesis-validity gates (DESIGN §10, layer one).
//
// These are not variances. A wrong-octave answer has sigma ~ 0.2 cents and is
// 1200 cents wrong; reducing everything to sigma hides precisely the failure R7
// exists to prevent. Hard gates refuse the reading; soft gates allow it, reduce
// confidence and explain themselves.
//
// The prototype's problem was not that gates existed -- it was that there were
// twenty-three of them, undocumented, and nothing recorded which one suppressed
// a reading. There are eight here, each is named, and each logs when it fires.

export const GATE_TEXT = {
  clipping:  'Too loud — move the phone back',
  polyphony: 'More than one note ringing',
  octave:    'Couldn’t pin down the octave',
  room:      'Too much background noise to tune here',
  course:    'Two strings sounding together',
  beating:   'Strings beating against each other',
  processing:'Your phone is processing the audio',
  stale:     'The room changed \u2014 re-read it',
};

export const HARD_GATES = new Set(['clipping', 'polyphony', 'octave', 'room']);

export function gcdAll(values) {
  let g = 0;
  for (const v of values) g = gcd(g, Math.abs(Math.round(v)));
  return g;
}

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

// Clipping generates harmonic distortion at EXACT integer ratios -- a
// perfectly harmonic fake series superimposed on the real inharmonic one. It
// pulls B-hat toward zero, biases f1, and does so with a LOW fit residual.
// That is a confident wrong answer, so it is a gate and not a sigma term.
export function detectClipping(buf, from, to) {
  let hot = 0, runs = 0, run = 0;
  const n = to - from;
  if (n <= 0) return false;
  for (let i = from; i < to; i++) {
    const v = Math.abs(buf.at(i));
    if (v > 0.985) {
      hot++;
      run++;
      if (run === 3) runs++;
    } else run = 0;
  }
  return hot / n > 0.001 || runs > 2;
}

// Odd and even partials implying different f1 beyond fit uncertainty. A
// 12-string's octave pair lands its fundamental exactly on the lower string's
// second partial, so even partials are pulled and the whole series still fits
// well -- and wrongly.
export function detectCourse(points, f1, B) {
  const odd = [], even = [];
  for (const p of points) {
    const implied = p.freq / (p.m * Math.sqrt((1 + B * p.m * p.m) / (1 + B)));
    (p.m % 2 ? odd : even).push(1200 * Math.log2(implied / f1));
  }
  if (odd.length < 2 || even.length < 2) return false;
  const mo = median(odd), me = median(even);
  const spread = Math.max(iqr(odd), iqr(even), 0.5);
  return Math.abs(mo - me) > 3 * spread && Math.abs(mo - me) > 4;
}

// Beating, discriminated rather than thresholded (DESIGN §7.2).
//
// A single plucked string's partial envelopes are routinely non-monotonic: the
// two transverse polarisations couple at the bridge and beat at a fraction of a
// hertz to a few hertz. Gating on that would discard most partials on most
// notes -- a tuner mysteriously refusing good plucks, which is worse than the
// failure it prevents. The two cases separate on depth and COHERENCE: own-string
// beating affects the whole series together, a foreign partial's is confined to
// one partial. Returns a per-partial weight in (0, 1]: de-weight, don't drop,
// because §7.3's robust regression already handles a noisy partial gracefully
// and on a bass there may be no partials to spare.
export function beatingWeights(envelopes) {
  const ms = [...envelopes.keys()];
  if (ms.length < 3) return { weights: new Map(ms.map((m) => [m, 1])), fired: false };

  const resid = new Map();
  let len = Infinity;
  for (const m of ms) len = Math.min(len, envelopes.get(m).length);
  if (len < 30) return { weights: new Map(ms.map((m) => [m, 1])), fired: false };

  for (const m of ms) {
    const e = envelopes.get(m).slice(-len);
    const y = e.map((v) => (v > 0 ? Math.log(v) : -30));
    resid.set(m, detrend(y));
  }

  // The series-common fluctuation: what all partials are doing together.
  const common = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const col = ms.map((m) => resid.get(m)[i]);
    common[i] = median(col);
  }

  const weights = new Map();
  let fired = false;
  for (const m of ms) {
    const r = resid.get(m);
    const depthDb = 8.686 * std(r);
    const coh = correlation(r, common);
    // Deep AND incoherent with the rest of the series.
    if (depthDb > 1.5 && coh < 0.35) {
      const w = Math.max(0.05, Math.min(1, 1.5 / depthDb));
      weights.set(m, w);
      if (w < 0.6) fired = true;
    } else weights.set(m, 1);
  }
  return { weights, fired };
}

function detrend(y) {
  const n = y.length;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = 0; i < n; i++) { st += i; sy += y[i]; stt += i * i; sty += i * y[i]; }
  const det = n * stt - st * st;
  const b = det ? (n * sty - st * sy) / det : 0;
  const a = (sy - b * st) / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = y[i] - (a + b * i);
  return out;
}

function std(a) {
  let s = 0, s2 = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; s2 += a[i] * a[i]; }
  const m = s / a.length;
  return Math.sqrt(Math.max(0, s2 / a.length - m * m));
}

function correlation(a, b) {
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / a.length, mb = sb / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function median(a) {
  const v = [...a].sort((p, q) => p - q);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

function iqr(a) {
  const v = [...a].sort((p, q) => p - q);
  if (v.length < 4) return Math.abs(v[v.length - 1] - v[0]) || 0.5;
  return v[Math.floor(v.length * 0.75)] - v[Math.floor(v.length * 0.25)];
}
