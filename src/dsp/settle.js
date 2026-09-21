// Temporal combination of successive estimates.
//
// DESIGN §8 deletes EXTRAPOLATION -- fitting y_inf + A e^(-t/theta) and
// reporting where the note will end up -- and the reasons are good: a normal
// pluck settles inside a second anyway, the hard pluck is exactly where the fit
// will not converge, and prediction is unbounded model risk.
//
// This is a different thing and the distinction matters. After §8's glide
// correction the reported pitch is already an estimate of a quantity that is
// stationary, so successive readings are repeated measurements of one number
// and combining them is ordinary estimation. What it must NOT do is lag: a
// player turning a peg needs the needle to follow. So it is a local LINEAR fit
// evaluated at the newest sample -- never beyond it -- which averages noise
// while tracking a genuine trend with no delay.
//
// §10 also requires the result to stay honest: if successive readings scatter
// more than their own sigmas predict, the scatter wins. That is what keeps the
// combined sigma from being a way of manufacturing confidence.

const SPAN = 1.2;              // seconds of history
const DECORRELATION = 0.45;    // the phase fit span: readings closer than this
                               // are not independent, so they do not count as
                               // separate measurements

export class Settler {
  constructor() { this.reset(); }

  reset() { this.t = []; this.cents = []; this.sigma = []; }

  // cents is relative to a fixed reference; caller keeps the reference stable
  // within a note. Returns { cents, sigma, n } or null.
  push(t, cents, sigma) {
    this.t.push(t); this.cents.push(cents); this.sigma.push(sigma);
    const cutoff = t - SPAN;
    while (this.t.length > 2 && this.t[0] < cutoff) {
      this.t.shift(); this.cents.shift(); this.sigma.shift();
    }
    return this.estimate();
  }

  estimate() {
    const n = this.t.length;
    if (!n) return null;
    const t0 = this.t[n - 1];
    if (n < 4) return { cents: this.cents[n - 1], sigma: this.sigma[n - 1], n: 1 };

    let S = 0, Su = 0, Suu = 0, Sy = 0, Suy = 0;
    for (let i = 0; i < n; i++) {
      const w = 1 / Math.max(1e-6, this.sigma[i] * this.sigma[i]);
      const u = this.t[i] - t0;
      S += w; Su += w * u; Suu += w * u * u;
      Sy += w * this.cents[i]; Suy += w * u * this.cents[i];
    }
    const det = S * Suu - Su * Su;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) {
      return { cents: this.cents[n - 1], sigma: this.sigma[n - 1], n: 1 };
    }
    const a = (Suu * Sy - Su * Suy) / det;     // value at u = 0, i.e. at now
    const b = (S * Suy - Su * Sy) / det;

    // Effective independent sample count. Overlapping phase fits share data, so
    // counting hops would understate sigma by a factor of seven.
    const span = t0 - this.t[0];
    const nEff = Math.max(1, Math.min(n, 1 + span / DECORRELATION));

    // Formal standard error of the intercept, then the scatter check. Whichever
    // is larger is the honest one.
    const formal = Math.sqrt(Math.max(0, Suu / det)) * Math.sqrt(n / nEff);
    let chi2 = 0;
    for (let i = 0; i < n; i++) {
      const u = this.t[i] - t0;
      const r = this.cents[i] - (a + b * u);
      chi2 += (r * r) / Math.max(1e-6, this.sigma[i] * this.sigma[i]);
    }
    const scatter = Math.sqrt(Math.max(1, chi2 / Math.max(1, n - 2)));
    const sigma = formal * scatter;

    // Never claim to be more certain than the best single reading divided by
    // the number of genuinely independent ones.
    const best = Math.min(...this.sigma);
    return { cents: a, sigma: Math.max(sigma, best / Math.sqrt(nEff)), n: nEff, trend: b };
  }
}
