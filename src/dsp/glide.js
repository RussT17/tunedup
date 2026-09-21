// The pitch glide, as a bound rather than a prediction (DESIGN §8).
//
// Displacing a string raises its average tension, so a pluck starts sharp and
// glides down: +5 cents for a soft pluck on this guitar, +18 to +25 for a hard
// one, and on a hard low E it takes over three seconds to come within a cent of
// where it settles. An earlier design fitted y = y_inf + A e^(-t/theta) and
// reported the settled value. That is deleted: a normal pluck settles inside a
// second anyway, the hard pluck is exactly where the fit does not converge, and
// three separate attempts to make it converge each made the normal case worse.
//
// What survives is the identity, which is exact for an exponential glide:
//
//     | y(t) - y_inf |  =  theta * | dy/dt |
//
// so the remaining error is DETERMINED by the chirp rate the phase fit already
// produces, given theta. This is why "commit when the chirp falls below
// 0.3 cents/s" was the wrong rule: a rate threshold bounds error/theta, not
// error. On a bass, where theta is two to three times longer, the same
// threshold buys 0.9 cents and eats R1's entire budget.
//
// theta is the log-slope of the first partial's POWER envelope -- the excess
// follows amplitude squared, so it decays at the power rate, half the
// amplitude time constant. Conflating the two is a factor-of-two error worth
// 16 cents of overshoot in the prototype.

const DB_PER_NEPER = 10 / Math.LN10;   // 4.3429: power dB per natural log unit
const SPAN = 1.6;          // seconds of envelope for the slope fit
// Physical range for a guitar's POWER-envelope time constant. A wound low E
// left to ring is the long end; a damped plain string is the short end.
const THETA_MIN = 0.25;
const THETA_MAX = 3.0;
const MIN_FALL_DB_S = 0.7; // the envelope must be clearly falling

// Instrument-class prior on theta, used only until the envelope is long enough
// to measure it. Guitar power-envelope constants run from about 0.4 s (a
// damped plain string) to 2.5 s (a ringing wound one); this is the geometric
// centre, with a width that spans the range.
const THETA_PRIOR = 1.0;
const THETA_PRIOR_SIGMA = 0.65;

export class GlideEstimator {
  constructor() { this.reset(); }

  reset() {
    this.theta = null;
    this.sigmaTheta = 0;
    this.held = false;
    this.slopeDbS = 0;
    this.fromM = null;
  }

  // Fit theta from a partial's amplitude history, supplied fresh each hop.
  //
  // An earlier version accumulated the envelope internally and locked onto
  // whichever partial was tracked first. That is wrong in a way that is easy
  // to miss: at note onset the fundamental is often not yet admitted (§2.3),
  // so the lock landed on a HIGH partial, which decays several times faster.
  // Measured on the sweep, theta read 0.28 s where the truth was 1.35 s, and
  // the glide was under-corrected by a factor of five. Choosing the partial
  // fresh each hop lets the fundamental take over the moment it appears.
  update(amps, hopSeconds, m) {
    this.fromM = m;
    const n = amps.length;
    const t = [], logP = [];
    for (let i = 0; i < n; i++) {
      if (!(amps[i] > 0)) continue;
      t.push((i - (n - 1)) * hopSeconds);
      logP.push(2 * Math.log(amps[i]));   // power = amplitude squared
    }
    if (t.length < 24) { this.held = this.theta !== null; return; }
    this._fit(t, logP);
  }

  // A robust slope over a span long compared with the polarisation beat
  // period. A single string's partial envelopes are routinely non-monotonic:
  // the two transverse polarisations couple at the bridge and beat at a
  // fraction of a hertz to a few hertz. That is ordinary guitar behaviour, not
  // a fault -- but a 3 dB beat at 1 Hz swings the local slope by +-9.4 dB/s
  // about a -4 dB/s decay, which crosses zero, and at the crossing theta
  // diverges and then INVERTS. A short local difference would put the needle
  // tens of cents out with the wrong sign.
  _fit(t, logP) {
    const slope = theilSen(t, logP);
    if (slope === null) { this.held = this.theta !== null; return; }
    this.slopeDbS = slope.b * DB_PER_NEPER;

    // How unstable is this slope, really? The formal standard error assumes
    // independent residuals and a polarisation beat is not one -- a 0.3 Hz
    // beat inside a 1.6 s window is a TREND, not noise, so the fit reports a
    // confident slope that is simply wrong. Measured on the sweep, theta read
    // 3.7 s where the truth was 1.6 s, with a formal error that said nothing.
    // Splitting the window and comparing halves sees exactly that instability,
    // because a beat moves the two halves in opposite directions while a real
    // decay does not.
    const half = Math.floor(t.length / 2);
    const a = theilSen(t.slice(0, half), logP.slice(0, half));
    const b = theilSen(t.slice(half), logP.slice(half));
    const split = a && b ? Math.abs(a.b - b.b) / 2 : 0;
    const seSlope = Math.max(slope.se, split);

    if (this.slopeDbS > -MIN_FALL_DB_S) {
      // Guard tripped: not clearly falling. Hold the last valid theta and let
      // the caller inflate sigma_d. Setting d to zero here would both leave
      // the reading uncorrected AND release the d <= 0.3 clause, so a beating
      // note would silently get an uncorrected number with nothing blocking
      // the in-tune claim.
      this.held = this.theta !== null;
      return;
    }
    const raw = -1 / slope.b;
    if (!(raw >= THETA_MIN && raw <= THETA_MAX)) { this.held = this.theta !== null; return; }
    const sigmaRaw = seSlope * raw * raw;     // d(theta)/d(slope) = theta^2

    // Shrink toward the instrument-class prior in proportion to how well the
    // measurement is actually determined. With a clean envelope the
    // measurement wins outright; under beating, where sigmaRaw is large, the
    // estimate falls back on physics rather than on a confident artefact. This
    // is the difference between over-correcting a glide by a factor of two and
    // not.
    const wMeas = 1 / (sigmaRaw * sigmaRaw + 1e-9);
    const wPrior = 1 / (THETA_PRIOR_SIGMA * THETA_PRIOR_SIGMA);
    this.theta = Math.max(THETA_MIN, Math.min(THETA_MAX,
      (raw * wMeas + THETA_PRIOR * wPrior) / (wMeas + wPrior)));
    this.sigmaTheta = Math.sqrt(1 / (wMeas + wPrior));
    this.held = false;
  }

  // chirpCentsPerSec is negative while the pitch glides down.
  // Returns { d, sigmaD, valid } with d >= 0, in cents, to be SUBTRACTED.
  //
  // theta needs one to two seconds of envelope before it means anything, while
  // d is LARGEST in the first second after the pluck -- so over the window
  // where the correction matters most, the quantity it is built from is least
  // trustworthy. Returning d = 0 with sigma_d = 0 there is the worst of the
  // available answers: it leaves a 17-cent glide uncorrected AND tells the
  // display policy that nothing is uncertain, which is how a tuner produces a
  // confident wrong number. Before theta is measurable, use the instrument
  // class prior with its own width, which corrects most of the glide and
  // declares what it does not know.
  bound(chirpCentsPerSec, sigmaChirp) {
    const rate = Math.abs(Math.min(0, chirpCentsPerSec));
    if (this.theta === null) {
      const d = THETA_PRIOR * rate;
      const sigmaD = Math.hypot(rate * THETA_PRIOR_SIGMA, THETA_PRIOR * sigmaChirp);
      return { d, sigmaD, valid: rate > 0, theta: null, prior: true };
    }
    const d = this.theta * rate;
    // The two measurement terms DESIGN §8 specifies, plus a floor for the
    // model risk of the identity itself. The glide is only exponential to the
    // extent the string's decay is, and neither theta nor the chirp rate can
    // see that. §8's own arithmetic -- theta to 20% and the chirp to 10% --
    // lands on sigma_d ~ 0.22 d, so that is the floor: the subtraction still
    // converts a 1-cent bias into a 0.22-cent uncertainty, which is the whole
    // reason for making it.
    let sigmaD = Math.hypot(rate * this.sigmaTheta, this.theta * sigmaChirp, 0.42 * d);
    if (this.held) sigmaD = Math.max(sigmaD, 0.5 * d + 0.3);
    return { d, sigmaD, valid: true, theta: this.theta, held: this.held };
  }

  // The glide amplitude at onset, for the "plucked hard" coaching line (§8).
  static pluckStrength(theta, chirpCentsPerSec) {
    return theta ? theta * Math.abs(Math.min(0, chirpCentsPerSec)) : 0;
  }
}

// Theil-Sen slope with a bootstrap-free standard error from the median
// absolute residual. The beat is not Gaussian, so a least-squares slope and
// its textbook standard error both misreport here.
function theilSen(t, y) {
  const n = t.length;
  if (n < 6) return null;
  const slopes = [];
  const stride = n > 40 ? 2 : 1;
  for (let i = 0; i < n - 1; i += stride) {
    for (let j = i + 1; j < n; j += stride) {
      const dt = t[j] - t[i];
      if (dt > 0.08) slopes.push((y[j] - y[i]) / dt);
    }
  }
  if (slopes.length < 5) return null;
  slopes.sort((a, b) => a - b);
  const b = slopes[Math.floor(slopes.length / 2)];

  const resid = [];
  let sumT = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumT += t[i]; sumY += y[i]; }
  const mt = sumT / n, my = sumY / n;
  const a = my - b * mt;
  let stt = 0;
  for (let i = 0; i < n; i++) {
    resid.push(Math.abs(y[i] - (a + b * t[i])));
    stt += (t[i] - mt) * (t[i] - mt);
  }
  resid.sort((p, q) => p - q);
  const sigma = 1.4826 * resid[Math.floor(resid.length / 2)];
  const se = stt > 0 ? sigma / Math.sqrt(stt) : Infinity;
  return { b, a, se };
}
