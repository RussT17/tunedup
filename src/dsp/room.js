// The room, as a per-bin power floor N[k] (DESIGN §5).
//
// A bin is admitted when P[k] > alpha * N[k]. Two mechanisms maintain N:
//
//   * Minimum statistics (Martin) as the primary, always-on estimator. It takes
//     a running minimum of smoothed per-bin power over a long window, which is
//     structurally incapable of learning a note: a note RAISES a bin and a
//     minimum ignores raises. That is the whole reason it is here instead of
//     the "is this the room or a note?" classifier an earlier design used --
//     that classifier, when wrong, went permanently deaf to the note it had
//     misfiled.
//
//   * Manual calibration, held by the user for a couple of seconds, as the
//     immediate re-baseline. Minimum statistics needs its whole window to
//     follow an abrupt change; a user whose dryer just started should not wait
//     thirty seconds. The handoff is defined (DESIGN §5): manual calibration
//     REPLACES N and CLEARS the minimum history, so retained old minima cannot
//     immediately override what the user just measured.
//
// The never-raise rule survives in the form that carries the safety property:
// no single frame can ever raise N. Raises happen only as old minima age out of
// the window, over tens of seconds, which is slow enough that a ringing note
// cannot drive one. A literal never-raise would make the floor monotonically
// decreasing and break R6 the first time an appliance switched on.

// Martin's D subwindows of U frames each. The window length is a direct trade:
// long enough that a sustained note cannot occupy all of it (which is what
// makes a minimum structurally unable to learn a note), short enough that an
// appliance switching ON is followed within a usable time. 15 s is past the
// longest a plucked string rings at a level that matters and is half the
// earlier 30 s, which left a dryer unmasked for most of a tuning session.
const SUBWINDOWS = 15;
const SUB_FRAMES = 100;         // 15 * 100 * 10 ms = 15 s
const SMOOTH_TAU = 0.4;         // seconds; smoothing before the minimum

export const ALPHA = 6;         // 7.8 dB admission margin (DESIGN §5)
export const ALPHA_STALE = 9;   // inflated while the profile rebuilds
export const PROFILE_LIFETIME = 20 * 60 * 1000; // ms

export class RoomProfile {
  constructor(nBins, sampleRate, fftSize) {
    this.nBins = nBins;
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.binHz = sampleRate / fftSize;

    this.smoothed = new Float64Array(nBins);
    this.noise = new Float64Array(nBins);
    this.subMin = [];
    for (let i = 0; i < SUBWINDOWS; i++) this.subMin.push(new Float64Array(nBins).fill(Infinity));
    this.current = new Float64Array(nBins).fill(Infinity);
    this.subCount = 0;
    this.subIndex = 0;

    this.frames = 0;
    this.seeded = false;
    this.calibratedAt = 0;
    this.mainsHz = 0;

    // The minimum of a noisy sequence sits below its mean. Martin derives a
    // full bias compensation; this is a single measured factor, calibrated
    // against room-tone recordings by tools/calibrate-room.mjs, with the
    // residual absorbed into alpha.
    this.biasComp = 2.4;   // measured, tools/calibrate-room.mjs on samples/room-tone.wav

    this.calibrating = false;
    this.calSum = null;
    this.calFrames = 0;

    // A fast minimum, for noticing that the room itself has changed.
    this.fastMin = new Float64Array(nBins).fill(Infinity);
    this.fastCount = 0;
    this.roomChanged = false;
  }

  get ready() { return this.seeded; }

  // True while the estimate is too young, or too old, to be trusted as-is.
  // DESIGN §5: run on the rebuilding estimate with an inflated alpha rather
  // than going deaf for thirty seconds.
  isStale(now = Date.now()) {
    if (!this.seeded) return true;
    if (this.frames < SUB_FRAMES * 2) return true;
    if (this.roomChanged) return true;
    return this.calibratedAt > 0 && now - this.calibratedAt > PROFILE_LIFETIME;
  }

  alphaNow(now = Date.now()) {
    return this.isStale(now) ? ALPHA_STALE : ALPHA;
  }

  invalidate() {
    for (const s of this.subMin) s.fill(Infinity);
    this.current.fill(Infinity);
    this.subCount = 0;
    this.subIndex = 0;
    this.frames = 0;
    this.seeded = false;
    this.calibratedAt = 0;
    this.fastMin.fill(Infinity);
    this.fastCount = 0;
    this.roomChanged = false;
  }

  // ---- minimum statistics ------------------------------------------------

  observe(power, dt) {
    const a = Math.exp(-dt / SMOOTH_TAU);
    const { smoothed, current } = this;

    if (!this.seeded) {
      smoothed.set(power);
      current.set(power);
      this.noise.set(power);
      this.seeded = true;
    } else {
      for (let k = 0; k < this.nBins; k++) {
        smoothed[k] = a * smoothed[k] + (1 - a) * power[k];
        if (smoothed[k] < current[k]) current[k] = smoothed[k];
      }
    }

    // Has the room CHANGED? A two-second minimum that sits well above the
    // stored floor across many bins at once is an appliance, not a note: a note
    // is narrowband and occupies a handful of bins, while a dryer raises a
    // broad swath. Worth saying out loud, because the remedy is one button.
    for (let k = 0; k < this.nBins; k++) {
      if (smoothed[k] < this.fastMin[k]) this.fastMin[k] = smoothed[k];
    }
    if (++this.fastCount >= 200) {
      let risen = 0, counted = 0;
      const kLo = Math.max(1, Math.floor(40 / this.binHz));
      const kHi = Math.min(this.nBins - 1, Math.ceil(2000 / this.binHz));
      for (let k = kLo; k <= kHi; k++) {
        counted++;
        if (this.fastMin[k] > 4 * this.noise[k]) risen++;
      }
      this.roomChanged = counted > 0 && risen / counted > 0.15;
      this.fastMin.fill(Infinity);
      this.fastCount = 0;
    }

    this.frames++;
    this.subCount++;
    if (this.subCount >= SUB_FRAMES) {
      this.subMin[this.subIndex].set(current);
      this.subIndex = (this.subIndex + 1) % SUBWINDOWS;
      this.subCount = 0;
      current.set(smoothed);
      this._recomputeNoise();
    } else {
      // Within a subwindow the floor may fall immediately but never rise.
      for (let k = 0; k < this.nBins; k++) {
        const v = current[k] * this.biasComp;
        if (v < this.noise[k]) this.noise[k] = v;
      }
    }
  }

  _recomputeNoise() {
    const { noise, subMin, current } = this;
    for (let k = 0; k < this.nBins; k++) {
      let m = current[k];
      for (let i = 0; i < SUBWINDOWS; i++) {
        const v = subMin[i][k];
        if (v < m) m = v;
      }
      noise[k] = m * this.biasComp;
    }
    this._detectMains();
  }

  // ---- manual calibration ------------------------------------------------

  beginCalibration() {
    this.calibrating = true;
    this.calSum = new Float64Array(this.nBins);
    this.calFrames = 0;
  }

  addCalibrationFrame(power) {
    if (!this.calibrating) return;
    for (let k = 0; k < this.nBins; k++) this.calSum[k] += power[k];
    this.calFrames++;
  }

  // Returns false and changes nothing if a note rang through the hold: DESIGN
  // §5 requires the manual path to refuse rather than learn the note. The
  // caller supplies the verdict, since it has the periodicity evidence.
  finishCalibration({ noteDetected = false } = {}) {
    const frames = this.calFrames;
    const sum = this.calSum;
    this.calibrating = false;
    this.calSum = null;
    this.calFrames = 0;
    if (noteDetected || frames < 40) return false;

    for (let k = 0; k < this.nBins; k++) this.noise[k] = sum[k] / frames;
    // Clear the minimum history so retained old minima cannot override this.
    for (const s of this.subMin) s.set(this.noise);
    this.current.set(this.noise);
    this.smoothed.set(this.noise);
    this.subCount = 0;
    this.subIndex = 0;
    this.frames = SUB_FRAMES * 2;
    this.seeded = true;
    this.calibratedAt = Date.now();
    this.fastMin.fill(Infinity);
    this.fastCount = 0;
    this.roomChanged = false;
    this._detectMains();
    return true;
  }

  // ---- use ---------------------------------------------------------------

  admits(k, power, alpha) {
    return power > alpha * this.noise[k];
  }

  // Soft gain for the NSDF path (DESIGN §7.1). A hard 0/1 mask rings -- sinc
  // tails around every retained band -- and the signal on this path is about to
  // be autocorrelated, where that ringing becomes a spurious period. This gain
  // is continuous with the hard mask: it reaches zero exactly at admission.
  softGain(power, alpha, out) {
    const { noise, nBins } = this;
    for (let k = 0; k < nBins; k++) {
      const p = power[k];
      out[k] = p > 0 ? Math.max(0, 1 - (alpha * noise[k]) / p) : 0;
    }
    // Smooth across bins so the gain curve has no step to ring on.
    let prev = out[0];
    for (let k = 1; k < nBins - 1; k++) {
      const v = 0.25 * prev + 0.5 * out[k] + 0.25 * out[k + 1];
      prev = out[k];
      out[k] = v;
    }
    return out;
  }

  // Mains and its harmonics are marked unusable rather than notched blindly
  // (DESIGN §5). The second partial of a bass low B sits 1.7 Hz from 60 Hz.
  _detectMains() {
    let best = 0, bestHz = 0;
    for (const hz of [50, 60]) {
      let s = 0;
      for (let h = 1; h <= 3; h++) {
        const k = Math.round((hz * h) / this.binHz);
        if (k < this.nBins) s += this.noise[k];
      }
      if (s > best) { best = s; bestHz = hz; }
    }
    // Only claim mains if it actually stands above its neighbourhood.
    const k = Math.round(bestHz / this.binHz);
    if (k > 2 && k + 3 < this.nBins) {
      const around = (this.noise[k - 3] + this.noise[k + 3]) / 2;
      this.mainsHz = this.noise[k] > 4 * around ? bestHz : 0;
    }
  }

  nearMains(freq) {
    if (!this.mainsHz) return false;
    const h = Math.round(freq / this.mainsHz);
    if (h < 1 || h > 8) return false;
    return Math.abs(freq - h * this.mainsHz) < 1.5 * this.binHz;
  }
}
