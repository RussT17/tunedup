// f1 and B together (DESIGN §7.3).
//
//   2 ln(f_m / m) = 2 ln f1 + ln(1 + B m^2) - ln(1 + B)
//                 ~ (2 ln f1 - B) + B m^2
//
// A weighted fit against m^2 yields both and needs no visible fundamental --
// which is the answer to §2.3, where the first partial can sit 10-20 dB below
// the third on an unplugged electric. This is the strongest idea in the design
// and every requirement below was learned by getting it wrong.

const LN2 = Math.LN2;
const CENTS = 1200 / LN2;

export const B_MAX_PHYSICAL = 1.5e-3;   // for rejecting foreign partials
export const B_PRIOR_GUITAR = 2e-4;     // instrument class, for the B = 0 rung

export function partialFreq(m, f1, B) {
  return m * f1 * Math.sqrt((1 + B * m * m) / (1 + B));
}

// The B a candidate partial would require, given a working f1. Foreign
// partials -- sympathetic ringing from other strings, room modes -- are
// rejected by physics rather than by a tuned threshold: they imply a B outside
// the range a steel string can have.
export function impliedB(m, freq, f1) {
  const rho = Math.pow(freq / (m * f1), 2);
  const denom = rho - m * m;
  if (Math.abs(denom) < 1e-12) return NaN;
  return (1 - rho) / denom;
}

// Whether a candidate partial is physically reachable from the working f1.
//
// Testing implied-B directly is the obvious form and it is wrong at low m:
// dB/d(f1 error) blows up as m -> 1, so an f1 that is a few cents off makes
// the SECOND partial imply a large negative B and the test throws away exactly
// the low partials §7.3 needs to pin f1 down. Ask the physical question
// instead -- is there ANY B in the physical range that reconciles this partial
// with an f1 inside the acquisition tolerance? -- which is well conditioned at
// every m.
export function partialPlausible(m, freq, f1, tolCents = 35, bMax = B_MAX_PHYSICAL) {
  if (m === 1) return Math.abs(1200 * Math.log2(freq / f1)) <= tolCents;
  const hi = freq / m;                                     // implied f1 at B = 0
  const lo = freq / (m * Math.sqrt((1 + bMax * m * m) / (1 + bMax)));
  const loF = f1 * Math.pow(2, -tolCents / 1200);
  const hiF = f1 * Math.pow(2, tolCents / 1200);
  return hi >= loF && lo <= hiF;
}

// Cost in cents of assuming B = 0 when the truth is B, for partial m.
export function bZeroCost(m, B) {
  return Math.abs(600 * Math.log2((1 + B * m * m) / (1 + B)));
}

/**
 * points: [{ m, freq, sigmaHz, weightScale }]
 * Returns { f1, B, sigmaCents, chi2dof, used, downweighted, rung } or null.
 */
export function fitF1B(points, { cachedB = null, cachedBSigma = 0, bPrior = B_PRIOR_GUITAR } = {}) {
  const pts = points.filter((p) => p.m >= 1 && p.freq > 0 && Number.isFinite(p.sigmaHz));
  if (pts.length < 2) return null;

  if (pts.length >= 4) {
    const joint = jointFit(pts);
    if (joint) return joint;
  }
  return anchoredFit(pts, cachedB, cachedBSigma, bPrior);
}

function jointFit(pts) {
  const n = pts.length;
  const x = new Float64Array(n);     // m^2
  const y = new Float64Array(n);     // 2 ln(f_m / m)
  const w = new Float64Array(n);     // 1 / var(y)
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    x[i] = p.m * p.m;
    y[i] = 2 * Math.log(p.freq / p.m);
    // var(y) = 4 sigma_f^2 / f^2. Phase-based frequency variance is roughly
    // constant in Hz across partials, so log-domain weights scale as f^2 and
    // high partials dominate by two orders of magnitude. Good for B; but f1 is
    // then an extrapolation back to m^2 = 1 with high leverage, which is why
    // the regression below is robust and the covariance is a sandwich.
    const varY = (4 * p.sigmaHz * p.sigmaHz) / (p.freq * p.freq);
    w[i] = varY > 0 ? (p.weightScale || 1) / varY : 0;
  }

  const first = wls(x, y, w);
  if (!first) return null;

  // chi^2 on the PRE-robustification residuals. IRLS exists to down-weight
  // exactly the outliers that raise chi^2, so computing it after would let the
  // robust fit silently disable the misfit detector meant to notice
  // contamination.
  let chi2 = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i] - (first.a + first.b * x[i]);
    chi2 += w[i] * r * r;
  }
  const dof = Math.max(1, n - 2);
  const chi2dof = chi2 / dof;

  // IRLS with a Huber loss.
  const rw = new Float64Array(n).fill(1);
  let fit = first;
  let downweighted = 0;
  for (let iter = 0; iter < 4; iter++) {
    const res = new Float64Array(n);
    for (let i = 0; i < n; i++) res[i] = (y[i] - (fit.a + fit.b * x[i])) * Math.sqrt(w[i]);
    const scale = 1.4826 * mad(res) || 1e-12;
    downweighted = 0;
    for (let i = 0; i < n; i++) {
      const z = Math.abs(res[i]) / (1.345 * scale);
      rw[i] = z <= 1 ? 1 : 1 / z;
      if (rw[i] < 0.999) downweighted++;
    }
    const eff = new Float64Array(n);
    for (let i = 0; i < n; i++) eff[i] = w[i] * rw[i];
    const next = wls(x, y, eff);
    if (!next) break;
    fit = next;
  }

  let B = fit.b;
  let lnF1 = (fit.a + fit.b) / 2;   // evaluate at m^2 = 1, NOT at the intercept:
                                    // at m^2 = 0 the value is 2 ln f1 - B, which
                                    // biases f1 sharp; at m^2 = 1 the correction
                                    // terms cancel exactly.

  // Sandwich covariance of (a, b), evaluated at m^2 = 1, so both the f1/B
  // anticorrelation and the robustification are accounted for. A naive
  // covariance after IRLS is optimistic, which R7 cannot afford.
  const eff = new Float64Array(n);
  for (let i = 0; i < n; i++) eff[i] = w[i] * rw[i];
  const cov = sandwich(x, y, eff, fit);
  // var(2 ln f1) = var(a + b) = Vaa + 2 Vab + Vbb
  let varLn = cov ? (cov[0][0] + 2 * cov[0][1] + cov[1][1]) / 4 : Infinity;

  // Inflate for model misfit (§10 term 5) -- but CAP the inflation. Beyond a
  // few-fold, chi^2 is no longer reporting that this estimate is imprecise; it
  // is reporting that the single-stiff-string hypothesis is wrong, and §3 is
  // explicit that a categorical failure has no variance representation. One
  // partial 10 cents out of series is 100 sigma, which uncapped becomes a
  // sigma of 300 cents -- a number that means nothing. The excess is handed to
  // the caller as `contaminated` so it can fire a gate instead.
  const inflation = Math.min(CHI2_CAP, Math.sqrt(Math.max(1, chi2dof)));
  varLn *= inflation * inflation;
  const contaminated = chi2dof > CHI2_CONTAMINATED;

  // One Gauss-Newton refinement on the exact model, seeded with the linear
  // B-hat. The first-order truncation costs 0.35 cents at m = 12 and 1.1 at
  // m = 16 for a plain string -- curvature, so it tilts the fit rather than
  // averaging out.
  const refined = gaussNewton(pts, Math.exp(lnF1), B, eff);
  if (refined) { lnF1 = Math.log(refined.f1); B = refined.B; }

  if (!(B > -1e-5) || B > B_MAX_PHYSICAL * 2) return null;
  const f1 = Math.exp(lnF1);
  if (!(f1 > 0) || !Number.isFinite(f1)) return null;

  let sigmaCents = CENTS * Math.sqrt(Math.max(0, varLn));

  // Leave-one-out. The log-domain weights make f1 an extrapolation from high
  // m^2 back to m^2 = 1, with high leverage and strong f1/B anticorrelation --
  // the regime where one contaminated partial moves f1 several cents at a LOW
  // residual, which is precisely what chi^2 cannot see. If dropping any single
  // partial moves the answer, say so in sigma.
  const loo = leaveOneOut(pts, x, y, eff, f1);
  if (loo !== null) sigmaCents = Math.max(sigmaCents, loo);

  return {
    f1,
    B: Math.max(0, B),
    sigmaCents,
    chi2dof,
    contaminated,
    looCents: loo,
    used: n,
    downweighted,
    rung: 'joint',
  };
}

const CHI2_CAP = 4;
const CHI2_CONTAMINATED = 25;

function leaveOneOut(pts, x, y, w, f1) {
  const n = pts.length;
  if (n < 5) return null;
  let worst = 0;
  const sub = new Float64Array(n);
  for (let drop = 0; drop < n; drop++) {
    sub.set(w);
    sub[drop] = 0;
    const f = wls(x, y, sub);
    if (!f) continue;
    const alt = Math.exp((f.a + f.b) / 2);
    if (!(alt > 0)) continue;
    const delta = Math.abs(CENTS * Math.log(alt / f1));
    if (delta > worst) worst = delta;
  }
  // Half the worst excursion: dropping a GOOD partial also moves the answer a
  // little, so the full excursion would double-count ordinary noise.
  return worst / 2;
}

function anchoredFit(pts, cachedB, cachedBSigma, bPrior) {
  const useCached = cachedB !== null && Number.isFinite(cachedB);
  const B = useCached ? cachedB : 0;

  // Work in cents of implied f1, which makes the bias term explicit.
  let sw = 0, swx = 0;
  const ref = pts[0].freq / pts[0].m;
  let biasWorst = 0;
  for (const p of pts) {
    const implied = p.freq / (p.m * Math.sqrt((1 + B * p.m * p.m) / (1 + B)));
    const c = CENTS * Math.log(implied / ref);
    const sigC = (CENTS * p.sigmaHz) / p.freq;
    // The model-uncertainty term. For the cached-B rung it is the cached
    // value's own uncertainty; for the B = 0 rung it is the INSTRUMENT-CLASS
    // prior -- not the 0..1.5e-3 range used to reject foreign partials, which
    // is a much wider bound serving a different purpose. Against that wider
    // bound this rung is dead: sigma >= 5 always, so the display would show
    // only a note name and never a reading.
    const bias = useCached ? bZeroCost(p.m, cachedBSigma) : bZeroCost(p.m, bPrior);
    biasWorst = Math.max(biasWorst, bias);
    const v = sigC * sigC + bias * bias;
    if (!(v > 0)) continue;
    const w = 1 / v;
    sw += w; swx += w * c;
  }
  if (!(sw > 0)) return null;
  const meanC = swx / sw;
  const sigmaCents = Math.sqrt(1 / sw);
  const f1 = ref * Math.pow(2, meanC / 1200);
  return {
    f1,
    B,
    sigmaCents,
    chi2dof: 1,
    used: pts.length,
    downweighted: 0,
    rung: useCached ? 'cachedB' : 'zeroB',
  };
}

function wls(x, y, w) {
  let S = 0, Sx = 0, Sxx = 0, Sy = 0, Sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const wi = w[i];
    if (!(wi > 0)) continue;
    S += wi; Sx += wi * x[i]; Sxx += wi * x[i] * x[i];
    Sy += wi * y[i]; Sxy += wi * x[i] * y[i];
  }
  const det = S * Sxx - Sx * Sx;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  return { a: (Sxx * Sy - Sx * Sxy) / det, b: (S * Sxy - Sx * Sy) / det, S, Sx, Sxx };
}

function sandwich(x, y, w, fit) {
  const n = x.length;
  let S = 0, Sx = 0, Sxx = 0;
  for (let i = 0; i < n; i++) { S += w[i]; Sx += w[i] * x[i]; Sxx += w[i] * x[i] * x[i]; }
  const det = S * Sxx - Sx * Sx;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  const bread = [[Sxx / det, -Sx / det], [-Sx / det, S / det]];
  let M00 = 0, M01 = 0, M11 = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i] - (fit.a + fit.b * x[i]);
    const wr2 = w[i] * w[i] * r * r;
    M00 += wr2; M01 += wr2 * x[i]; M11 += wr2 * x[i] * x[i];
  }
  const meat = [[M00, M01], [M01, M11]];
  const bm = mul2(bread, meat);
  return mul2(bm, bread);
}

function mul2(A, B) {
  return [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]],
  ];
}

function gaussNewton(pts, f1, B, w) {
  let u = Math.log(f1), b = B;
  for (let iter = 0; iter < 2; iter++) {
    let H00 = 0, H01 = 0, H11 = 0, g0 = 0, g1 = 0;
    for (let i = 0; i < pts.length; i++) {
      const m = pts[i].m, m2 = m * m;
      const wi = w[i];
      if (!(wi > 0)) continue;
      const pred = 2 * u + Math.log(1 + b * m2) - Math.log(1 + b);
      const obs = 2 * Math.log(pts[i].freq / m);
      const r = obs - pred;
      const j0 = 2;
      const j1 = m2 / (1 + b * m2) - 1 / (1 + b);
      H00 += wi * j0 * j0; H01 += wi * j0 * j1; H11 += wi * j1 * j1;
      g0 += wi * j0 * r;   g1 += wi * j1 * r;
    }
    const det = H00 * H11 - H01 * H01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
    const du = (H11 * g0 - H01 * g1) / det;
    const db = (H00 * g1 - H01 * g0) / det;
    u += du; b += db;
    if (!(b > -1e-5)) b = 0;
  }
  const f = Math.exp(u);
  return Number.isFinite(f) && f > 0 ? { f1: f, B: Math.max(0, b) } : null;
}

function mad(a) {
  const v = [...a].map(Math.abs).sort((p, q) => p - q);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}
