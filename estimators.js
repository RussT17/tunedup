import { spectrum, refinePeak } from './pitch.js';

// Each mode is a different answer to the same question: a plucked string's
// pitch is not a constant, so which number should the tuner show?
//
// A plucked string starts sharp. Displacement stretches the string, average
// tension rises with the square of the amplitude, and the pitch rides that
// up — then glides back down as the note decays. The offset is not a short
// transient: it decays with the amplitude envelope, which on a low string is
// seconds long. The physically well-defined target is the zero-amplitude
// pitch, the limit the string approaches as it goes quiet, and what a very
// soft pluck would read. That is what 'predict' and 'studio' estimate
// directly rather than waiting for.

export const MODES = [
  {
    id: 'standard',
    label: 'Standard',
    blurb: 'v1: median of the last 220 ms. Follows the pluck sharp and drops the note early.',
  },
  {
    id: 'sustain',
    label: 'Sustain',
    blurb: 'Skips the first 250 ms of the pluck and tracks the decay far below the old cut-off.',
  },
  {
    id: 'predict',
    label: 'Predict',
    blurb: 'Fits pitch against amplitude² over the whole pluck and reports the settled pitch.',
  },
  {
    id: 'strobe',
    label: 'Strobe',
    blurb: 'Phase-tracks the clearest partial. Hears quiet low strings; sub-cent resolution.',
  },
  {
    id: 'studio',
    label: 'Studio',
    blurb: 'Strobe lock feeding the settled-pitch fit. Best of both, and the most to go wrong.',
  },
];

export const STRINGS = [
  { id: 'auto', label: 'Auto', midi: null },
  { id: 'e2', label: '6th · E2', midi: 40 },
  { id: 'a2', label: '5th · A2', midi: 45 },
  { id: 'd3', label: '4th · D3', midi: 50 },
  { id: 'g3', label: '3rd · G3', midi: 55 },
  { id: 'b3', label: '2nd · B3', midi: 59 },
  { id: 'e4', label: '1st · E4', midi: 64 },
];

const ATTACK_SKIP = 0.25;        // seconds of pluck ignored by sustain/strobe
const MAX_CENTS_PER_SECOND = 400;   // ~25x faster than anyone turns a peg
const MAX_TARGET_CENTS = 300;    // reject readings this far from a chosen string

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

const cents = (a, b) => 1200 * Math.log2(a / b);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Ratio of partial m to partial 1 for a string with inharmonicity B. */
function stretch(m, B) {
  return Math.sqrt((1 + B * m * m) / (1 + B));
}

class Estimator {
  constructor(context) {
    this.ctx = context;     // { sampleRate, engine, targetHz() }
    this.reset();
  }

  reset() {
    this.settled = 0;
    this.settledAt = -1;
    this.onsetId = -1;
  }

  /** True when `frequency` is plausible for the string the user selected. */
  onTarget(frequency) {
    const target = this.ctx.targetHz();
    return !target || Math.abs(cents(frequency, target)) < MAX_TARGET_CENTS;
  }

  /** Common shape for "nothing new this tick". */
  hold(frame, detail = '') {
    if (!this.settled) return { frequency: 0, status: 'idle', detail };
    const fresh = frame.time - this.settledAt < 0.35;
    return { frequency: this.settled, status: fresh ? 'live' : 'held', detail };
  }

  publish(frame, frequency, detail = '', settled = true) {
    // A ringing string cannot move hundreds of cents between two 40 ms ticks.
    // Anything that fast is the estimator coming apart as the note dies, so
    // hold the last good reading instead of showing the wreckage.
    if (this.settled && frame.onsetId === this.guardOnsetId) {
      const elapsed = Math.max(0.02, frame.time - this.settledAt);
      if (Math.abs(cents(frequency, this.settled)) / elapsed > MAX_CENTS_PER_SECOND) {
        return this.hold(frame, 'holding');
      }
    }
    this.guardOnsetId = frame.onsetId;
    this.settled = frequency;
    this.settledAt = frame.time;
    return { frequency, status: 'live', detail, settled };
  }

  /** What the mode is currently fitting, for the trace view. Null when it fits nothing. */
  fitInfo() {
    return null;
  }
}

/** v1, kept verbatim as the baseline to compare against. */
class StandardEstimator extends Estimator {
  reset() {
    super.reset();
    this.history = [];
  }

  update(frame) {
    if (frame.f0 && frame.clarity > 0.7 && frame.rms > 0.004 && this.onTarget(frame.f0)) {
      this.history.push({ time: frame.time, frequency: frame.f0 });
    }
    while (this.history.length && frame.time - this.history[0].time > 0.22) this.history.shift();
    if (this.history.length >= 2) {
      return this.publish(frame, median(this.history.map((h) => h.frequency)));
    }
    return this.hold(frame);
  }
}

/** Ignore the attack, then follow the note down to the noise floor. */
class SustainEstimator extends Estimator {
  reset() {
    super.reset();
    this.history = [];
  }

  update(frame) {
    if (frame.onsetId !== this.onsetId) {
      this.onsetId = frame.onsetId;
      this.history.length = 0;
    }
    if (frame.onsetAge !== null && frame.onsetAge < ATTACK_SKIP) {
      return { ...this.hold(frame), status: 'settling', detail: 'settling' };
    }

    const floor = Math.max(frame.noiseFloor * 2.5, frame.peakRms * 0.02);
    if (frame.f0 && frame.clarity > 0.6 && frame.rms > floor && this.onTarget(frame.f0)) {
      this.history.push({ time: frame.time, frequency: frame.f0 });
    }
    while (this.history.length && frame.time - this.history[0].time > 0.4) this.history.shift();
    if (this.history.length >= 3) {
      return this.publish(frame, median(this.history.map((h) => h.frequency)));
    }
    return this.hold(frame);
  }
}

/**
 * Estimates the pitch the string is settling towards instead of waiting for it.
 *
 * The frequency offset from a pluck decays with the string's energy, so the
 * reading follows  y(t) = settled + A·e^(-t/θ).  Fitting that curve — θ by grid
 * search, settled and A in closed form at each θ — extrapolates to the pitch
 * the note is heading for, seconds before it arrives. Measuring against
 * amplitude² instead is the more obvious route, and was the first thing tried,
 * but broadband amplitude decays faster than the fundamental does and the
 * intercept comes out sharp.
 */
// Plausible decay times for the glide on a steel string: it follows the square
// of the amplitude envelope, so roughly half the note's own decay time.
const DECAY_CANDIDATES = [0.3, 0.45, 0.6, 0.8, 1.1, 1.5, 2, 2.6];
const MAX_EXTRAPOLATION_CENTS = 35;

class PredictEstimator extends Estimator {
  reset() {
    super.reset();
    this.points = [];
    this.anchor = 0;
    this.origin = 0;
  }

  collect(frame, frequency, weight = 1) {
    if (!this.anchor) {
      this.anchor = frequency;
      this.origin = frame.time;
    }
    this.points.push({ t: frame.time - this.origin, y: cents(frequency, this.anchor), w: weight });
    if (this.points.length > 500) this.points.shift();
  }

  solve() {
    const points = this.points;
    if (points.length < 6) return null;
    const span = points[points.length - 1].t - points[0].t;

    let best = null;
    for (const theta of DECAY_CANDIDATES) {
      let sw = 0, sb = 0, sbb = 0, sy = 0, sby = 0;
      for (const p of points) {
        const basis = Math.exp(-p.t / theta);
        sw += p.w; sb += p.w * basis; sbb += p.w * basis * basis;
        sy += p.w * p.y; sby += p.w * basis * p.y;
      }
      const denom = sw * sbb - sb * sb;
      if (Math.abs(denom) < 1e-9) continue;
      const amplitude = (sw * sby - sb * sy) / denom;
      const settled = (sy - amplitude * sb) / sw;
      let residual = 0;
      for (const p of points) {
        const error = p.y - (settled + amplitude * Math.exp(-p.t / theta));
        residual += p.w * error * error;
      }
      residual /= sw;
      if (!best || residual < best.residual) best = { residual, settled, amplitude, theta };
    }
    if (!best) return null;

    const latest = points[points.length - 1].y;
    best.latest = latest;
    best.span = span;
    best.rms = Math.sqrt(best.residual);

    // How much of the modelled decay we have actually watched happen. Over a
    // short span an exponential looks like a straight line and extrapolates to
    // nonsense, so the correction is faded in as the evidence arrives rather
    // than trusted or discarded outright.
    const elapsed = points[points.length - 1].t;
    best.progress = 1 - Math.exp(-elapsed / best.theta);
    const sane = best.amplitude > -1 && best.rms < 3 && points.length >= 8;
    best.trust = sane
      ? Math.max(0, Math.min(1, (best.progress - 0.15) / 0.5)) *
        Math.max(0, Math.min(1, (span - 0.3) / 0.5))
      : 0;

    const correction = Math.max(
      -MAX_EXTRAPOLATION_CENTS,
      Math.min(1, best.settled - latest) * best.trust
    );
    best.reported = latest + correction;
    best.ok = best.trust > 0.05;
    return best;
  }

  fitInfo() {
    const fit = this.solve();
    return fit ? { ...fit, anchor: this.anchor, origin: this.origin } : null;
  }

  update(frame) {
    if (frame.onsetId !== this.onsetId) {
      this.onsetId = frame.onsetId;
      this.points.length = 0;
      this.anchor = 0;
    }
    if (frame.onsetAge === null) return this.hold(frame);

    const floor = Math.max(frame.noiseFloor * 2.5, frame.peakRms * 0.015);
    if (frame.f0 && frame.clarity > 0.6 && frame.rms > floor && this.onTarget(frame.f0)) {
      this.collect(frame, frame.f0, frame.clarity);
    }
    if (this.points.length < 4) return { ...this.hold(frame), status: 'settling', detail: 'settling' };

    const fit = this.solve();
    if (!fit) return this.hold(frame);
    const trusted = fit.trust > 0.6;
    return this.publish(
      frame,
      this.anchor * Math.pow(2, fit.reported / 1200),
      trusted ? `settled · pluck +${fit.amplitude.toFixed(1)}c` : 'still settling',
      trusted
    );
  }
}

/**
 * Narrowband phase tracking, the way a strobe tuner works. Locks onto one
 * partial, demodulates the contiguous stream against a fixed reference, and
 * reads frequency off the phase slope. Precision comes from the length of the
 * baseline rather than the size of an FFT, and because everything outside a
 * few Hz is rejected it keeps hearing a string long after broadband methods
 * lose it.
 */
class StrobeEstimator extends Estimator {
  reset() {
    super.reset();
    this.lock = null;
    this.frames = [];
    this.scratch = null;
    this.lastOffset = null;
    this.peakDemod = 0;
    this.resyncs = 0;
  }

  /** Pick the partial with the best signal, and measure the string's inharmonicity. */
  analysePartials(frame) {
    const { engine, sampleRate } = this.ctx;
    const size = 8192;
    if (!this.scratch || this.scratch.length !== size) this.scratch = new Float32Array(size);
    if (!engine.read(this.scratch)) return null;

    const { magnitude, fftSize } = spectrum(this.scratch, size);
    const peaks = [];
    for (let m = 1; m <= 10; m++) {
      const target = frame.f0 * m;
      if (target > sampleRate / 2.5) break;
      const peak = refinePeak(magnitude, fftSize, sampleRate, target);
      if (peak && peak.snr > 4) peaks.push({ m, ...peak });
    }
    if (!peaks.length) return null;

    // Inharmonicity from all the partials at once. A stiff string puts partial m
    // at m·f1·sqrt(1 + B·m²), so 2·ln(f_m / m) is linear in m² with slope B.
    // Regressing that uses every partial and does not care whether the
    // fundamental — often the weakest thing on a solid body — was found at all.
    let B = 0;
    if (peaks.length >= 3) {
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const p of peaks) {
        const w = Math.log(1 + p.snr);
        const x = p.m * p.m;
        const y = 2 * Math.log(p.frequency / p.m);
        sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
      }
      const denom = sw * sxx - sx * sx;
      if (denom) B = Math.max(0, Math.min(5e-3, (sw * sxy - sx * sy) / denom));
    }

    // Prefer a loud partial, with a nudge towards low ones: they carry less
    // inharmonicity error and are less likely to be a neighbour's harmonic.
    let best = peaks[0];
    let bestScore = -Infinity;
    for (const p of peaks) {
      const score = Math.log(p.amplitude) - 0.25 * (p.m - 1);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return { partial: best.m, B, snr: best.snr };
  }

  /** Σ x·hann·e^(-iωn) over the newest `length` samples, phase referenced to absolute time. */
  demodulate(endSample, length, frequency) {
    const { engine, sampleRate } = this.ctx;
    if (!this.window || this.window.length !== length) this.window = new Float32Array(length);
    if (!engine.read(this.window, endSample)) return null;

    const start = endSample - length;
    const w = (2 * Math.PI * frequency) / sampleRate;
    const c = Math.cos(w);
    const s = Math.sin(w);
    let pr = Math.cos(w * start);
    let pi = -Math.sin(w * start);
    let re = 0;
    let im = 0;
    for (let i = 0; i < length; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
      const x = this.window[i] * hann;
      re += x * pr;
      im += x * pi;
      const nr = pr * c + pi * s;
      pi = pi * c - pr * s;
      pr = nr;
      if ((i & 1023) === 1023) {
        const mag = Math.hypot(pr, pi) || 1;
        pr /= mag; pi /= mag;
      }
    }
    return { re, im, amplitude: (2 * Math.hypot(re, im)) / length };
  }

  /** Phase slope between the newest frame and one `baseline` seconds back. */
  slopeAt(baseline, priorHz) {
    const { sampleRate } = this.ctx;
    const latest = this.frames[this.frames.length - 1];
    const wanted = latest.sample - baseline * sampleRate;
    let previous = null;
    for (let i = this.frames.length - 2; i >= 0; i--) {
      if (this.frames[i].sample <= wanted) { previous = this.frames[i]; break; }
    }
    if (!previous) return null;
    const dt = (latest.sample - previous.sample) / sampleRate;
    const dPhase = Math.atan2(latest.im, latest.re) - Math.atan2(previous.im, previous.re);
    // The slope is only known modulo one turn per dt, so take the value nearest
    // the prior. A prior that is wrong by more than half a turn lands on the
    // wrong one and is then wrong by a constant — hence the cross-check below.
    const turns = Math.round((2 * Math.PI * priorHz * dt - dPhase) / (2 * Math.PI));
    return (dPhase + 2 * Math.PI * turns) / (2 * Math.PI * dt);
  }

  /**
   * Unwrap against progressively longer baselines. The short baseline is the
   * median of several overlapping pairs: averaging its noise down is what makes
   * the long baseline's unwrap safe.
   */
  measureOffset(priorHz) {
    const short = [];
    for (const baseline of [0.06, 0.08, 0.1, 0.14]) {
      const value = this.slopeAt(baseline, priorHz);
      if (value !== null) short.push(value);
    }
    if (!short.length) return null;
    const coarse = median(short);
    const refined = this.slopeAt(0.3, coarse);
    return refined === null ? coarse : refined;
  }

  update(frame) {
    const { sampleRate } = this.ctx;
    if (frame.onsetId !== this.onsetId) {
      this.onsetId = frame.onsetId;
      this.lock = null;
      this.frames.length = 0;
      this.lastOffset = null;
      this.peakDemod = 0;
      this.onNewNote();
    }
    if (frame.onsetAge === null) return this.hold(frame);

    if (!this.lock) {
      if (frame.onsetAge < 0.06 || !frame.f0 || !this.onTarget(frame.f0)) {
        return { ...this.hold(frame), status: 'settling', detail: 'locking on' };
      }
      const analysis = this.analysePartials(frame);
      if (!analysis) return { ...this.hold(frame), status: 'settling', detail: 'locking on' };
      const { partial, B } = analysis;
      this.lock = {
        partial,
        B,
        reference: frame.f0 * partial * stretch(partial, B),
      };
    }

    const periods = Math.round((8 * sampleRate) / this.lock.reference);
    const length = Math.min(Math.max(periods, Math.round(sampleRate * 0.15)), 1 << 14);
    const z = this.demodulate(frame.sample, length, this.lock.reference);
    if (!z) return this.hold(frame);
    this.peakDemod = Math.max(this.peakDemod, z.amplitude);
    this.frames.push({ sample: frame.sample, re: z.re, im: z.im, amplitude: z.amplitude });
    while (this.frames.length > 80) this.frames.shift();

    // Once the partial sinks towards the noise the phase is just noise too, and
    // unwrapping it produces wild jumps. Stop rather than jitter.
    if (z.amplitude < Math.max(frame.noiseFloor * 1.5, this.peakDemod * 0.004)) {
      return this.hold(frame, 'faded');
    }

    if (frame.onsetAge < ATTACK_SKIP && !this.trackThroughAttack) {
      return { ...this.hold(frame), status: 'settling', detail: 'settling' };
    }

    // Prior for unwrapping. The previous measurement is far steadier than a
    // fresh MPM estimate, which is the first thing to fall apart in noise;
    // MPM only seeds the very first measurement after a lock.
    const coarse = frame.f0
      ? frame.f0 * this.lock.partial * stretch(this.lock.partial, this.lock.B) - this.lock.reference
      : 0;
    const offset = this.measureOffset(this.lastOffset === null ? coarse : this.lastOffset);
    if (offset === null) return this.hold(frame);

    // Cross-check the phase track against the pitch detector. They disagree by
    // a few cents routinely; a disagreement this large means the unwrapper is a
    // whole turn out, which would otherwise read as a confident wrong answer.
    // The ambiguity at the long baseline is exactly 1/0.3 s = 3.3 Hz, so a
    // disagreement approaching half of that is a wrong turn rather than
    // ordinary estimator noise. Measured in Hz, not cents: the size of a wrong
    // turn is fixed in Hz and shrinks in cents as the partial rises.
    if (frame.f0 && frame.clarity > 0.75 && Math.abs(offset - coarse) > 1.4) {
      this.lastOffset = coarse;
      this.resyncs = (this.resyncs || 0) + 1;
      if (this.resyncs > 5) {
        // Persistent disagreement means the lock itself is wrong — often a
        // re-pluck beating against the note still ringing. Start over.
        this.lock = null;
        this.frames.length = 0;
        this.lastOffset = null;
        this.resyncs = 0;
      }
      return this.hold(frame, 'resyncing');
    }
    this.resyncs = 0;
    this.lastOffset = offset;

    const partialHz = this.lock.reference + offset;
    const frequency = partialHz / (this.lock.partial * stretch(this.lock.partial, this.lock.B));
    if (!Number.isFinite(frequency) || frequency <= 0 || !this.onTarget(frequency)) return this.hold(frame);

    return this.onMeasurement(frame, frequency, z.amplitude);
  }

  onNewNote() {}

  onMeasurement(frame, frequency) {
    return this.publish(frame, frequency, `${ORDINALS[this.lock.partial - 1]} partial`);
  }
}

/** Strobe lock feeding the settled-pitch fit. */
class StudioEstimator extends StrobeEstimator {
  constructor(context) {
    super(context);
    this.trackThroughAttack = true;   // the fit needs the loud part of the note
  }

  onNewNote() {
    this.predictor = new PredictEstimator(this.ctx);
  }

  fitInfo() {
    const info = this.predictor ? this.predictor.fitInfo() : null;
    return info && this.lock ? { ...info, partial: this.lock.partial, B: this.lock.B } : info;
  }

  onMeasurement(frame, frequency) {
    if (!this.predictor) this.onNewNote();
    this.predictor.collect(frame, frequency, 1);

    const ordinal = ORDINALS[this.lock.partial - 1];
    const fit = this.predictor.solve();
    if (!fit) {
      if (frame.onsetAge < ATTACK_SKIP) {
        return { ...this.hold(frame), status: 'settling', detail: 'settling' };
      }
      return this.publish(frame, frequency, `${ordinal} partial`, frame.onsetAge > 1.5);
    }
    const trusted = fit.trust > 0.6;
    return this.publish(
      frame,
      this.predictor.anchor * Math.pow(2, fit.reported / 1200),
      trusted ? `${ordinal} partial · pluck +${fit.amplitude.toFixed(1)}c` : `${ordinal} partial · settling`,
      trusted
    );
  }
}

const CONSTRUCTORS = {
  standard: StandardEstimator,
  sustain: SustainEstimator,
  predict: PredictEstimator,
  strobe: StrobeEstimator,
  studio: StudioEstimator,
};

export function createEstimator(id, context) {
  const Constructor = CONSTRUCTORS[id] || StandardEstimator;
  return new Constructor(context);
}
