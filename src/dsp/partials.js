// Per-partial tracking by complex heterodyne (DESIGN §7.2).
//
// Each partial is mixed to baseband at its current frequency estimate and
// low-passed by a Hann-windowed integrate-and-dump. That filter is the same
// object as an FFT bin evaluated at an arbitrary re-centred frequency, so it
// keeps every correctness property of heterodyne -- no bin boundaries for a
// drifting partial to cross, no integer ambiguity -- while collapsing the
// tracking filter and the analysis window into one structure with one latency.
//
// Length is set per partial from the MEAN of the two local spacings,
//
//     T_m = 8 / (f_{m+1} - f_{m-1}),  with f_0 = 0
//
// which puts the neighbouring partials on the window's null. The naive 4/f1
// does not, for high partials on a stiff string: at m = 12 on a plain string
// the neighbour lands 37% of the way from the null to the next sidelobe peak,
// back at Hann's bare -31 dB against a 60 dB requirement -- and on exactly the
// partials §7.3's log-domain weighting says dominate the fit.
//
// The output is timestamped at the WINDOW CENTRE, which removes the filter's
// group delay exactly. That delay is a known-sign bias: the filter lags, so on
// a falling pitch the reported frequency reads sharp by delay * |df/dt|,
// compounding with §8's glide bias in the same direction.

const TWO_PI = Math.PI * 2;
const wrap = (x) => { let v = x % TWO_PI; if (v > Math.PI) v -= TWO_PI; if (v < -Math.PI) v += TWO_PI; return v; };
// Phase history per frequency fit. sigma for a slope falls as T^-1.5, so this
// is the single most expensive parameter in the design: 0.18 s and 0.5 s
// differ by a factor of 4.6 in sigma. It is traded against R2 (a usable
// reading within 1 s) and against the quadratic phase model's fidelity -- an
// exponential glide is not a chirp, and over a long enough span the cubic term
// shows up in the residual, which inflates sigma honestly but does inflate it.
// Swept by tools/sweep-span.mjs against both harnesses.
const FIT_SPAN = Number(globalThis.TUNEDUP_FIT_SPAN) || 0.45;
const MIN_FIT = 8;           // samples needed before a fit is attempted
const MAX_FIT = 128;
const HANN_ENBW = 1.5;

export class PartialTracker {
  constructor(sampleRate, hopSamples) {
    this.sampleRate = sampleRate;
    this.hop = hopSamples;
    this.dt = hopSamples / sampleRate;
    this.partials = new Map();  // m -> state
    this.origin = 0;            // absolute sample index this note started at
  }

  reset(originSample) {
    this.partials.clear();
    this.origin = originSample;
  }

  // Declare which harmonic numbers to track, and where they are expected.
  //
  // Re-centring is lossless but not free, so it is done only when the residual
  // offset is a real fraction of the passband. The filter is deliberately wide
  // -- half-bandwidth f1/2, so the neighbour sits at the band edge -- and a
  // partial a few cents off its reference is nowhere near the skirt. Chasing
  // the spectral peak every hop instead would re-centre on peak-picking noise,
  // and the phase record is the one thing in this design that must not have a
  // seam in it.
  setPartials(list) {
    const keep = new Set();
    for (const { m, freq, length, passband } of list) {
      keep.add(m);
      let p = this.partials.get(m);
      if (!p) {
        this.partials.set(m, {
          m, fRef: freq, length,
          t: [], phase: [], amp: [],
          lastRaw: null, accum: 0, lastT: 0,
          freq, chirp: 0, sigmaHz: Infinity, ok: false,
        });
        continue;
      }
      const delta = freq - p.fRef;
      const trigger = Math.max(1, 0.15 * (passband || freq * 0.05));
      if (Math.abs(delta) > trigger) {
        // Rewrite the carried phase into the new reference frame:
        //   phi'(t) = phi(t) - 2*pi*delta*t
        // so the accumulator, the history and the next hop's unwrap all stay
        // consistent and no fit span is lost.
        for (let i = 0; i < p.phase.length; i++) p.phase[i] -= TWO_PI * delta * p.t[i];
        p.accum -= TWO_PI * delta * p.lastT;
        if (p.lastRaw !== null) p.lastRaw = wrap(p.lastRaw - TWO_PI * delta * p.lastT);
        p.fRef = freq;
        // Length follows the estimate, but only alongside a re-centre: changing
        // the integrator length changes the filter, and doing that every hop
        // would modulate the very phase being measured.
        p.length = length;
      }
    }
    for (const m of [...this.partials.keys()]) if (!keep.has(m)) this.partials.delete(m);
  }

  // ring: { at(absoluteIndex) -> sample, first, last }
  // endSample: absolute index one past the newest sample.
  step(ring, endSample) {
    const fs = this.sampleRate;
    for (const p of this.partials.values()) {
      const L = Math.min(p.length, endSample - ring.first);
      if (L < 32) { p.ok = false; continue; }
      const start = endSample - L;

      // Recursive complex rotation: one pair of trig calls per partial per hop
      // instead of one per sample. Phase is referenced to the note's own
      // origin, so the argument never grows large enough to lose precision.
      const w = (-TWO_PI * p.fRef) / fs;
      const rel = start - this.origin;
      const ph0 = w * rel;
      let cr = Math.cos(ph0), ci = Math.sin(ph0);
      const dr = Math.cos(w), di = Math.sin(w);

      let sr = 0, si = 0;
      const norm = TWO_PI / L;
      for (let j = 0; j < L; j++) {
        const win = 0.5 - 0.5 * Math.cos(norm * j);
        const x = ring.at(start + j) * win;
        sr += x * cr;
        si += x * ci;
        const nr = cr * dr - ci * di;
        ci = cr * di + ci * dr;
        cr = nr;
      }

      const mag = Math.hypot(sr, si);
      const amp = (4 * mag) / L;           // Hann coherent gain is 1/2, and the
                                           // analytic half carries half the energy
      const raw = Math.atan2(si, sr);
      const tc = (start + (L - 1) / 2 - this.origin) / fs;

      if (p.lastRaw === null) { p.accum = 0; }
      else {
        let d = raw - p.lastRaw;
        while (d > Math.PI) d -= TWO_PI;
        while (d < -Math.PI) d += TWO_PI;
        p.accum += d;
      }
      p.lastRaw = raw;
      p.lastT = tc;
      const unwrapped = p.accum;

      p.t.push(tc); p.phase.push(unwrapped); p.amp.push(amp);
      const cutoff = tc - FIT_SPAN;
      while (p.t.length > MIN_FIT && (p.t[0] < cutoff || p.t.length > MAX_FIT)) { p.t.shift(); p.phase.shift(); p.amp.shift(); }

      this._fit(p, L / fs);
    }
  }

  // Quadratic phase model -- frequency plus chirp rate. §2.1 says the pitch
  // chirps downward for seconds; fitting a straight line recovers the mean
  // frequency over the span but dumps a systematic term into the residual, so
  // sigma would be worst exactly where §8 needs it most. One extra basis
  // function keeps the residual an honest noise estimate and hands §8 the
  // glide rate directly.
  _fit(p, windowSeconds) {
    const n = p.t.length;
    if (n < MIN_FIT) { p.ok = false; return; }
    const t0 = p.t[n - 1];
    let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, Y0 = 0, Y1 = 0, Y2 = 0;
    for (let i = 0; i < n; i++) {
      const u = p.t[i] - t0, y = p.phase[i];
      const u2 = u * u;
      S0 += 1; S1 += u; S2 += u2; S3 += u2 * u; S4 += u2 * u2;
      Y0 += y; Y1 += y * u; Y2 += y * u2;
    }
    const A = [[S0, S1, S2], [S1, S2, S3], [S2, S3, S4]];
    const b = [Y0, Y1, Y2];
    const sol = solve3(A, b);
    if (!sol) { p.ok = false; return; }
    const [, slope, curve] = sol;

    let ss = 0;
    for (let i = 0; i < n; i++) {
      const u = p.t[i] - t0;
      const pred = sol[0] + slope * u + curve * u * u;
      const r = p.phase[i] - pred;
      ss += r * r;
    }
    const dof = n - 3;
    const varRes = dof > 0 ? ss / dof : 0;

    // Standard error of the slope, from the (1,1) element of the inverse.
    const inv = invert3(A);
    const seSlope = inv ? Math.sqrt(Math.max(0, varRes * inv[1][1])) : Infinity;

    // Successive phase samples are not independent: the integrator is longer
    // than the hop. Treating them as independent understates the slope
    // variance and hence sigma, and an optimistic sigma is the most direct
    // route to violating R7. The inflation is sqrt(L_eff / D).
    const inflate = Math.sqrt(Math.max(1, windowSeconds / (HANN_ENBW * this.dt)));

    p.freq = p.fRef + slope / TWO_PI;
    p.chirp = curve / Math.PI;                    // Hz per second
    p.sigmaHz = (seSlope / TWO_PI) * inflate;
    p.ok = Number.isFinite(p.freq) && Number.isFinite(p.sigmaHz);
  }

  get(m) { return this.partials.get(m); }
  list() { return [...this.partials.values()]; }
}

function solve3(A, b) {
  const inv = invert3(A);
  if (!inv) return null;
  return [0, 1, 2].map((i) => inv[i][0] * b[0] + inv[i][1] * b[1] + inv[i][2] * b[2]);
}

function invert3(A) {
  const [a, bb, c] = A;
  const det =
    a[0] * (bb[1] * c[2] - bb[2] * c[1]) -
    a[1] * (bb[0] * c[2] - bb[2] * c[0]) +
    a[2] * (bb[0] * c[1] - bb[1] * c[0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  const d = 1 / det;
  return [
    [(bb[1] * c[2] - bb[2] * c[1]) * d, (a[2] * c[1] - a[1] * c[2]) * d, (a[1] * bb[2] - a[2] * bb[1]) * d],
    [(bb[2] * c[0] - bb[0] * c[2]) * d, (a[0] * c[2] - a[2] * c[0]) * d, (a[2] * bb[0] - a[0] * bb[2]) * d],
    [(bb[0] * c[1] - bb[1] * c[0]) * d, (a[1] * c[0] - a[0] * c[1]) * d, (a[0] * bb[1] - a[1] * bb[0]) * d],
  ];
}

// T_m = 8 / (f_{m+1} - f_{m-1}), with f_0 = 0 so the fundamental needs no
// special case: that gives T_1 = 8/f_2, identical to the ideal one-sided
// 4/(f_2 - f_1) because f_2 is 2*f_1 to within B.
export function integratorLength(m, f1, B, sampleRate, maxSamples) {
  const fm = (k) => (k <= 0 ? 0 : k * f1 * Math.sqrt((1 + B * k * k) / (1 + B)));
  const spread = fm(m + 1) - fm(m - 1);
  const seconds = spread > 0 ? 8 / spread : 4 / f1;
  return Math.max(64, Math.min(maxSamples, Math.round(seconds * sampleRate)));
}

export function partialFreq(m, f1, B) {
  return m * f1 * Math.sqrt((1 + B * m * m) / (1 + B));
}
