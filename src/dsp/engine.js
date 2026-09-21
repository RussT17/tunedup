// The pipeline, assembled (DESIGN §3).
//
//   worklet: DC blocker + copy -> ring buffer (absolute sample index)
//        -> frames, 10 ms hop -> window -> FFT
//        -> room profile -> per-bin admission
//        -> note state machine | acquisition (NSDF) | partial tracker
//        -> joint f1/B fit + covariance
//        -> validity gates | sigma
//        -> display decision
//
// Everything above this line is pure: no AudioContext, no DOM. The same code
// runs in the worker and in tools/, which is the only reason any of it can be
// measured.

import { FFT, powerSpectrum } from './fft.js';
import { blackmanHarris, hann, coherentGain } from './window.js';
import { Ring, DCBlocker } from './ring.js';
import { RoomProfile } from './room.js';
import { Acquirer } from './acquire.js';
import { PartialTracker, integratorLength, partialFreq } from './partials.js';
import { fitF1B, partialPlausible } from './fit.js';
import { GlideEstimator } from './glide.js';
import { Settler } from './settle.js';
import { beatingWeights, detectClipping, detectCourse, gcdAll, HARD_GATES } from './gates.js';
import { nearestNote, MIN_F0, MAX_F0, A4 } from './notes.js';

const FRAME = 4096;
const HOP_SECONDS = 0.01;
const MAX_PARTIAL = 16;
const MAX_TRACK_HZ = 5000;
const ACQ_EVERY = 6;            // acquisition runs at ~17 Hz; only the partial
                                // tracker needs the full hop rate (DESIGN §4)
const ONSET_LEVEL_DB = 5.0;     // dB, calibrated by tools/calibrate-onset.mjs
const ONSET_FLUX = 2.8;         // dB, calibrated by tools/calibrate-onset.mjs
const REF_A = Math.exp(-HOP_SECONDS / 0.1);   // 100 ms reference-spectrum memory
const SLOW_A = Math.exp(-HOP_SECONDS / 2.0);  // 2 s memory, for the onset snapshot
const REF_RISE = 2.5;           // a bin must beat its own recent history by this
const ONSET_RISE = 3;           // to join the note: 4.8 dB over the pre-onset level
const ONSET_KEEP = 1.2;         // to stay in it: 0.8 dB         // to stay in it: 1.8 dB           // a partial must beat its own pre-onset level by 6 dB
const DYNAMIC_RANGE_DB = 50;    // a partial further below the loudest than the
                                // analysis can separate is not measurable (§7.2)
const SIGMA_FLOOR = 0.15;       // phone sample clocks are +-20-50 ppm (DESIGN §10)
const QUIET_MS = 250;
const LOCK_WINDOW = 0.4;        // seconds after onset during which acquisition may set f1

export const STATE = { QUIET: 'quiet', ATTACK: 'attack', SUSTAIN: 'sustain', RELEASE: 'release' };

export class Engine {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.a4 = options.a4 || A4;
    this.hop = Math.round(sampleRate * HOP_SECONDS);
    this.frameSize = FRAME;

    this.ring = new Ring(FRAME * 4);
    this.dc = new DCBlocker(sampleRate);
    this.fft = new FFT(FRAME);
    this.winMon = blackmanHarris(FRAME);
    this.winAcq = hann(FRAME);
    // Room power is learned on the monitor window; the NSDF path uses Hann.
    // For broadband noise the two differ by a constant ratio of window energy.
    this.windowScale = energy(this.winAcq) / energy(this.winMon);

    this.frame = new Float64Array(FRAME);
    this.re = new Float64Array(FRAME);
    this.im = new Float64Array(FRAME);
    this.power = new Float64Array(FRAME / 2 + 1);
    this.refSpec = new Float64Array(FRAME / 2 + 1);
    this.slowSpec = new Float64Array(FRAME / 2 + 1);
    this.binHz = sampleRate / FRAME;

    this.room = new RoomProfile(FRAME / 2 + 1, sampleRate, FRAME);
    this.acq = new Acquirer(FRAME, sampleRate);
    this.tracker = new PartialTracker(sampleRate, this.hop);
    this.glide = new GlideEstimator();
    this.settler = new Settler();

    this.nextHopAt = FRAME;
    this.hopIndex = 0;
    this.state = STATE.QUIET;
    this.noteStart = 0;
    this.quietSince = 0;
    this.levelHistory = [];
    this.fluxArmed = 0;
    this.envelopes = new Map();
    this.cachedB = new Map();     // midi note -> B, cached per string (§7.3)

    this.f1 = null;
    this.B = 0;
    this.lastPublished = null;
    this.result = idleResult();
    this.onResult = options.onResult || null;
    this.calibrating = false;
    this.calibrationNote = false;
    this.diag = options.diag ? [] : null;
  }

  // ---- ingest ------------------------------------------------------------

  push(chunk) {
    const copy = chunk instanceof Float32Array ? chunk.slice() : Float32Array.from(chunk);
    this.dc.process(copy);
    this.ring.write(copy);
    while (this.ring.end >= this.nextHopAt) {
      this._hop(this.nextHopAt);
      this.nextHopAt += this.hop;
    }
    return this.result;
  }

  // A gap, device change or route change invalidates every piece of carried
  // state that assumes sample continuity.
  discontinuity() {
    this.ring.reset();
    this.dc.reset();
    this.nextHopAt = FRAME;
    this._endNote();
    this.room.invalidate();
  }

  setA4(hz) { this.a4 = hz; }

  beginCalibration() {
    this.calibrating = true;
    this.calibrationNote = false;
    this.room.beginCalibration();
  }

  // Returns true if the room was actually re-baselined. The manual path must
  // refuse when a note rings through it (DESIGN §5): learning the note would be
  // exactly the failure minimum statistics exists to avoid.
  finishCalibration() {
    const ok = this.room.finishCalibration({ noteDetected: this.calibrationNote });
    this.calibrating = false;
    return ok;
  }

  cancelCalibration() {
    this.room.calibrating = false;
    this.room.calSum = null;
    this.room.calFrames = 0;
    this.calibrating = false;
  }

  // ---- one hop -----------------------------------------------------------

  _hop(endSample) {
    this.hopIndex++;
    const start = endSample - FRAME;
    const { ring, frame, winMon } = this;
    for (let i = 0; i < FRAME; i++) frame[i] = ring.at(start + i) * winMon[i];
    powerSpectrum(this.fft, frame, this.re, this.im, this.power);

    const alpha = this.room.alphaNow();
    this.room.observe(this.power, HOP_SECONDS);

    if (this.calibrating) {
      this.room.addCalibrationFrame(this.power);
      if (this._periodicDuringCalibration()) this.calibrationNote = true;
      this.result = { ...idleResult(), state: 'calibrating', calibrating: true };
      this._emit();
      return;
    }

    const level = this._admittedLevelDb(alpha);
    const flux = this._onsetEvidence(alpha);
    const clipping = detectClipping(ring, endSample - this.hop, endSample);

    const onset = this._onsetCheck(level, flux);
    if (onset) this._startNote(endSample);

    if (this.state === STATE.QUIET) {
      if (!onset) { this.result = idleResult(); this._emit(); return; }
    }

    this._selectPartials(alpha);
    this.tracker.step(ring, endSample);
    this._recordEnvelopes();

    const t = (endSample - this.noteStart) / this.sampleRate;
    const env = this._envelopePartial();
    this.envelopeM = env ? env.m : undefined;
    if (env) this.glide.update(env.e, HOP_SECONDS, env.m);

    this._advanceState(level, endSample);
    this.result = this._estimate({ alpha, level, clipping, t });
    this._emit();
  }

  _emit() { if (this.onResult) this.onResult(this.result); }

  // ---- note state machine (DESIGN §6) ------------------------------------

  _admittedLevelDb(alpha) {
    const { power, room } = this;
    let s = 0, floor = 0;
    const kLo = Math.max(1, Math.floor(MIN_F0 / this.binHz) - 1);
    const kHi = Math.min(power.length - 1, Math.ceil(MAX_TRACK_HZ / this.binHz));
    for (let k = kLo; k <= kHi; k++) {
      floor += alpha * room.noise[k];
      if (power[k] > alpha * room.noise[k]) s += power[k];
    }
    // Floored on the room's own contribution: in silence the admitted sum is
    // near zero and a bare dB of it swings tens of dB on nothing at all, which
    // is how a level-rise test ends up with a background p90 of 10 dB.
    return 10 * Math.log10(s + floor + 1e-20);
  }

  // Onset evidence, restricted to bins the current note's partial model does
  // not explain (DESIGN §6).
  //
  // Restricting to unexplained bins is the load-bearing idea: a new note is
  // precisely energy at frequencies the current note does not explain, and the
  // regime the prototype failed in was a soft pluck over a still-ringing
  // string, where broadband level barely moves. Power-domain flux is dominated
  // by the loudest partial and is therefore highly sensitive to amplitude
  // modulation -- and two nearly in-tune strings BEAT, which is what tuning
  // produces, giving periodic power rises indistinguishable from an onset.
  //
  // The statistic is the NEW energy appearing above both the room floor and a
  // short-memory reference spectrum, expressed in dB relative to the room's own
  // contribution in those same bins. That normalisation is what makes one
  // threshold work in a quiet room and a loud one: it asks how far above the
  // room the new energy is, not how many absolute units of it there are.
  // Measured margin against a pluck detector sharing no code with it:
  // tools/calibrate-onset.mjs.
  _onsetEvidence(alpha) {
    const { power, room, refSpec } = this;
    const explained = this._explainedBins();
    const kLo = Math.max(1, Math.floor(MIN_F0 / this.binHz) - 1);
    const kHi = Math.min(power.length - 1, Math.ceil(MAX_TRACK_HZ / this.binHz));
    let fresh = 0, floor = 0;
    for (let k = kLo; k <= kHi; k++) {
      const p = power[k];
      const n = alpha * room.noise[k];
      if (!explained || !explained.has(k)) {
        floor += n;
        const over = p - Math.max(REF_RISE * refSpec[k], n);
        if (over > 0) fresh += over;
      }
      refSpec[k] = REF_A * refSpec[k] + (1 - REF_A) * p;
      // A much slower memory, for the snapshot taken at onset. By the time an
      // onset is DETECTED the fast reference already contains the note, so
      // snapshotting that would compare the note against itself. At two
      // seconds, a hum running since before the pluck is fully present and a
      // 50 ms-old note is barely three percent of the way in.
      this.slowSpec[k] = SLOW_A * this.slowSpec[k] + (1 - SLOW_A) * p;
    }
    return floor > 0 ? 10 * Math.log10(1 + fresh / floor) : 0;
  }

  _explainedBins() {
    if (this.state === STATE.QUIET || !this.f1) return null;
    const set = new Set();
    for (let m = 1; m <= MAX_PARTIAL; m++) {
      const f = partialFreq(m, this.f1, this.B);
      if (f > MAX_TRACK_HZ) break;
      const k = Math.round(f / this.binHz);
      for (let d = -2; d <= 2; d++) set.add(k + d);
    }
    return set;
  }

  _onsetCheck(level, flux) {
    this.levelHistory.push(level);
    if (this.levelHistory.length > 8) this.levelHistory.shift();
    const rise = this.levelHistory.length >= 6
      ? level - Math.min(...this.levelHistory.slice(0, 3))
      : 0;

    const hit = rise > ONSET_LEVEL_DB || flux > ONSET_FLUX;
    // Two consecutive hops, in both regimes: background flux is uncorrelated
    // between hops and a real attack is not.
    if (hit) this.fluxArmed++;
    else this.fluxArmed = 0;
    if (this.fluxArmed < 2) return false;
    if (this.state !== STATE.QUIET && (endedRecently(this.hopIndex, this.lastOnsetHop))) return false;
    this.lastOnsetHop = this.hopIndex;
    this.fluxArmed = 0;
    return true;
  }

  _startNote(endSample) {
    // Snapshot what the spectrum held immediately before this note.
    if (!this.onsetSpec) this.onsetSpec = new Float64Array(this.slowSpec.length);
    this.onsetSpec.set(this.slowSpec);
    this.noteMs = new Set();
    this.noteStart = endSample;
    this.state = STATE.ATTACK;
    this.tracker.reset(endSample);
    this.glide.reset();
    this.settler.reset();
    this.envelopes.clear();
    this.f1 = null;
    this.B = 0;
    this.acqSince = 0;
    this.continuityUntil = 0;
    this.locked = false;
    this.noteMs = new Set();
    this.lastPublished = null;
    this.quietSince = 0;
    this.envelopePeak = 0;
    this.envelopeM = undefined;
    this.settleRef = 0;
  }

  _endNote() {
    this.state = STATE.QUIET;
    this.f1 = null;
    this.B = 0;
    this.tracker.reset(this.ring.end);
    this.glide.reset();
    this.settler.reset();
    this.envelopes.clear();
  }

  _advanceState(level, endSample) {
    const t = (endSample - this.noteStart) / this.sampleRate;
    if (this.state === STATE.ATTACK && t > 0.06 && this.f1) this.state = STATE.SUSTAIN;

    const env = this._envelopePartial();
    if (env && env.e.length) {
      const amp = env.e[env.e.length - 1];
      const peak = this.envelopePeak || 0;
      this.envelopePeak = Math.max(peak, amp);
      // The release test uses the tracked partial's envelope, not broadband
      // power: a broadband envelope falls steeply while the high partials die
      // and then slowly, so a broadband threshold declares release early on
      // exactly the notes that sustain longest (DESIGN §6, §9).
      if (this.state === STATE.SUSTAIN && amp < 0.02 * this.envelopePeak) {
        this.state = STATE.RELEASE;
      }
    }

    // A note ends when it is both too quiet to measure AND no longer periodic
    // (DESIGN §6). Ending on level alone cut soft strings off while they were
    // still perfectly readable -- but dropping the periodicity half is worse in
    // a different way: in a quiet room the admission threshold is a small
    // number, so noise keeps clearing it, partials keep "tracking" and the note
    // never ends. That is the frenetic jumping in silence this tuner was
    // reported for. Periodicity does not care how quiet the room is: noise has
    // none at any level.
    const measurable = this.tracker.list().some((p) => p.ok) && this.acqClarity > 0.5;
    if (!measurable) {
      if (!this.quietSince) this.quietSince = endSample;
      if ((endSample - this.quietSince) / this.sampleRate > QUIET_MS / 1000) {
        this._endNote();
        this.envelopePeak = 0;
      }
    } else this.quietSince = 0;
  }

  _periodicDuringCalibration() {
    if (this.hopIndex % ACQ_EVERY) return false;
    const start = this.ring.end - FRAME;
    const f = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) f[i] = this.ring.at(start + i);
    const got = this.acq.run(f, { noise: zeroNoise, alpha: 0, scale: 1 });
    return !!(got && got.clarity > 0.8);
  }

  // ---- partial selection -------------------------------------------------

  _selectPartials(alpha) {
    if (this.hopIndex % ACQ_EVERY === 0 || !this.f1) this._acquire(alpha);
    if (!this.f1) { this.tracker.setPartials([]); return; }

    const list = [];
    let bestSnr = 0;
    const maxLen = Math.floor(this.ring.cap / 2);
    for (let m = 1; m <= MAX_PARTIAL; m++) {
      const predicted = partialFreq(m, this.f1, this.B);
      if (predicted > Math.min(MAX_TRACK_HZ, this.sampleRate * 0.45)) break;
      const peak = this._peakNear(
        predicted, this.f1 / 3, alpha,
        Math.max(1.5 * this.binHz, predicted * 0.05),   // ~85 cents
      );
      if (!peak) continue;
      if (this.room.nearMains(peak.freq)) continue;
      // A partial of THIS note must have arrived with it. Anything already
      // present at the same frequency when the note began -- an appliance, a
      // room mode, a string still ringing from before -- is not this note's,
      // whatever the room profile happens to say.
      //
      // This is what makes the tuner survive a dryer that starts up after the
      // room was measured. The profile cannot know about it yet and minimum
      // statistics needs fifteen seconds to catch up; the onset snapshot knows
      // immediately, because the hum was in it and the note was not. Measured:
      // it is the difference between 15 missed strings in six stitched
      // sessions and 2.
      //
      // The test decides which bins BELONG to this note, so it is applied
      // while the note is young and the answer is then remembered. Applying it
      // for the life of the note instead cuts tracking short on exactly the
      // notes that sustain longest: a decaying partial falls back toward its
      // pre-onset level, fails the test, and the tuner stops reading a string
      // that is still perfectly audible. Measured, that cost half the tracking
      // duration R5 asks for.
      // Two levels: strict to JOIN the note, looser to STAY in it. Joining
      // decides which bins belong to this note and wants a clear margin;
      // staying only asks whether the partial is still distinguishable from
      // what was there before, and a decaying string spends most of its life
      // in between. One threshold for both jobs forces a choice between
      // accuracy and tracking duration; measured, that choice cost either
      // 0.25 cents of settled error or half of R5.
      if (this.onsetSpec) {
        const young = (this.ring.end - this.noteStart) / this.sampleRate < LOCK_WINDOW;
        const need = (young || !this.noteMs.has(m)) ? ONSET_RISE : ONSET_KEEP;
        if (peak.power < need * this.onsetSpec[peak.bin]) continue;
        if (young) this.noteMs.add(m);
      }
      if (!partialPlausible(m, peak.freq, this.f1)) continue;
      if (peak.snr > bestSnr) bestSnr = peak.snr;
      list.push({
        m, freq: peak.freq, passband: this.f1 / 2, power: peak.power,
        length: integratorLength(m, this.f1, this.B, this.sampleRate, maxLen),
      });
    }

    // Dynamic range, which the room floor alone does not supply.
    //
    // Admission asks whether a bin is above the ROOM. In a genuinely quiet
    // room -- or a recording with a digitally silent lead-in -- that floor
    // approaches zero and every analysis sidelobe becomes an admissible
    // "partial". The tracker then locks onto leakage, the phase record is
    // noise, and sigma reads two hundred cents. §7.2 derives a 60 dB stopband
    // for the partial filter for exactly this reason: a partial further below
    // its neighbours than the analysis can separate is not measurable, whatever
    // the room is doing.
    const loudest = list.reduce((a, p) => Math.max(a, p.power), 0);
    const floor = loudest * Math.pow(10, -DYNAMIC_RANGE_DB / 10);
    const usable = list.filter((p) => p.power >= floor);
    this.admittedCount = usable.length;
    this.bestSnr = bestSnr;
    this.tracker.setPartials(usable);
  }

  // Search wide, accept narrow. The search window has to be wide enough to
  // find a partial that inharmonicity and a rough f1 have moved; the
  // ACCEPTANCE has to be narrow or any spectral bump within a third of f1
  // counts as a partial. Conflating the two is why an earlier version of the
  // octave guard scored noise at 1.00 and descended on clean notes.
  _peakNear(freq, tolerance, alpha, accept = Infinity) {
    const { power, room } = this;
    const kLo = Math.max(1, Math.floor((freq - tolerance) / this.binHz));
    const kHi = Math.min(power.length - 2, Math.ceil((freq + tolerance) / this.binHz));
    let bestK = -1, best = 0;
    for (let k = kLo; k <= kHi; k++) {
      if (power[k] > best && power[k] >= power[k - 1] && power[k] >= power[k + 1]) { best = power[k]; bestK = k; }
    }
    if (bestK < 1 || !(best > alpha * room.noise[bestK])) return null;
    const a = Math.log(power[bestK - 1] + 1e-30);
    const b = Math.log(power[bestK] + 1e-30);
    const c = Math.log(power[bestK + 1] + 1e-30);
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const snr = best / (room.noise[bestK] + 1e-30);
    const refined = (bestK + Math.max(-1, Math.min(1, shift))) * this.binHz;
    if (Math.abs(refined - freq) > accept) return null;
    return { freq: refined, snr, power: best, bin: bestK };
  }

  // Acquisition answers "which note is this?" ONCE per note, and then stops.
  //
  // Letting it re-lock f1 for the life of the note was a mistake that took
  // three attempts to see. The strong third partial of a hard low E makes
  // acquisition oscillate between f and 3f; guarding against that upward
  // locked in any mis-lock at onset; allowing downward re-locks freely made it
  // descend repeatedly to f/2, f/4. All three are the same error -- acquisition
  // is a period-finder, and running one continuously against its own previous
  // answer is a feedback loop with no reference.
  //
  // After the lock window, f1 comes from the fit, which follows a peg turn
  // continuously, and a genuinely new note arrives through the onset detector,
  // which clears f1 outright. Acquisition stays on only as the periodicity
  // evidence for the note-end rule.
  _acquire(alpha) {
    const start = this.ring.end - FRAME;
    const { frame, ring } = this;
    for (let i = 0; i < FRAME; i++) frame[i] = ring.at(start + i);
    const got = this.acq.run(frame, { noise: this.room.noise, alpha, scale: this.windowScale });
    this.acqClarity = got ? got.clarity : 0;
    if (!got || got.clarity < 0.55) return;

    const sinceOnset = (this.ring.end - this.noteStart) / this.sampleRate;
    if (this.f1 && sinceOnset > LOCK_WINDOW) return;

    // Within the lock window, re-evaluate from the raw acquisition each time --
    // never from the previous f1 -- so the octave guard cannot compound.
    this.f1 = this._preferSubharmonic(got.freq, alpha);
    if (!this.locked) { this.B = 0; this.locked = true; }
  }

  // The octave-UP guard, which is the error §2.3 makes likely: on an unplugged
  // solid body the fundamental can sit 10-20 dB below the third partial, and
  // acquisition then locks onto a higher period. None of §7.1's other defences
  // catch it -- the comb GCD test passes cleanly when the surviving partials
  // are 3 and 5 of a fundamental three times too high, which is exactly what a
  // hard low E produced here.
  //
  // The discriminating question is NOT "does the candidate explain the
  // spectrum" -- every sub-harmonic does, since its predicted partials are a
  // superset of the real ones. It is whether the partials a sub-harmonic
  // predicts that the HIGHER series does not are actually there. For a true
  // fundamental at f/3 those are its partials 1, 2, 4, 5, 7, 8 and they carry
  // most of the note's energy; for a spurious one they are empty spectrum.
  _subharmonicSupported(freq, div, alpha) {
    const limit = Math.min(MAX_TRACK_HZ, this.sampleRate * 0.45);
    let hits = 0, total = 0;
    for (let j = 1; j <= 3 * div; j++) {
      if (j % div === 0) continue;        // coincides with the higher series
      const predicted = (j * freq) / div;
      if (predicted < MIN_F0 * 0.85 || predicted > limit) continue;
      total++;
      const tol = Math.max(1.2 * this.binHz, predicted * 0.03);
      if (this._peakNear(predicted, tol, alpha, tol)) hits++;
    }
    return total >= 3 && hits / total >= 0.6;
  }

  _preferSubharmonic(freq, alpha) {
    for (const div of [3, 2]) {
      const cand = freq / div;
      if (cand < MIN_F0) continue;
      if (this._subharmonicSupported(freq, div, alpha)) return cand;
    }
    return freq;
  }

  _recordEnvelopes() {
    for (const p of this.tracker.list()) {
      let e = this.envelopes.get(p.m);
      if (!e) { e = []; this.envelopes.set(p.m, e); }
      e.push(p.amp.length ? p.amp[p.amp.length - 1] : 0);
      if (e.length > 160) e.shift();
    }
    for (const m of [...this.envelopes.keys()]) if (!this.tracker.get(m)) this.envelopes.delete(m);
  }

  // The envelope §8 and §9 need is ONE partial's, held for the life of the
  // note -- the first if it is trackable, otherwise the lowest that is.
  //
  // Taking "the loudest partial" instead looks harmless and is not: the
  // loudest partial CHANGES as the high ones die, so the envelope jumps every
  // time the winner changes, and theta -- the log-slope of that envelope --
  // reads far too short. This is the same trap §9 warns about for broadband
  // level, arriving by a different route. It was measuring theta = 0.16 s on a
  // guitar whose real value is about 1.1 s, which is a 7x error in the glide
  // correction.
  // The LOWEST partial with enough history, re-chosen every hop so the
  // fundamental takes over as soon as it is admitted.
  _envelopePartial() {
    let chosen = null;
    for (const [m, e] of this.envelopes) {
      if (e.length < 24) continue;
      if (!chosen || m < chosen.m) chosen = { m, e };
    }
    if (!chosen) for (const [m, e] of this.envelopes) if (!chosen || m < chosen.m) chosen = { m, e };
    return chosen;
  }

  // ---- the estimate ------------------------------------------------------

  _estimate({ alpha, level, clipping, t }) {
    const gates = [];
    if (clipping) gates.push('clipping');
    if (this.room.isStale()) gates.push('stale');
    if (this.hopIndex < (this.continuityUntil || 0)) gates.push('octave');

    const tracked = this.tracker.list().filter((p) => p.ok && p.sigmaHz < p.freq * 0.02);
    if (tracked.length < 2) {
      if (this.state !== STATE.QUIET) gates.push('room');
      return this._present(null, gates, { t });
    }

    // The harmonic-comb GCD check. If the admitted partials' implied harmonic
    // numbers share a common factor -- masking may leave only 4, 6, 8 -- the
    // period looks halved and every other octave defence passes. It is also
    // what makes "gating does not move the NSDF peak" a test rather than an
    // assumption.
    const g = gcdAll(tracked.map((p) => p.m));
    if (g > 1) gates.push('octave');

    const { weights, fired } = beatingWeights(this.envelopes);
    if (fired) gates.push('beating');

    const points = tracked.map((p) => ({
      m: p.m,
      freq: p.freq,
      sigmaHz: Math.max(p.sigmaHz, 1e-4),
      weightScale: weights.get(p.m) ?? 1,
    }));

    const midiHint = this.f1 ? nearestNote(this.f1, this.a4).midi : null;
    const cached = midiHint !== null ? this.cachedB.get(midiHint) : null;
    const fit = fitF1B(points, { cachedB: cached ?? null, cachedBSigma: 5e-5 });
    if (!fit) { gates.push('room'); return this._present(null, gates, { t }); }

    // NOT a polyphony signal: a large chi^2 means the partials do not sit on
    // one stiff-string series, which on real audio happens constantly from
    // sympathetic ringing and mode splitting. It is already inside sigma
    // (capped, §7.3). Polyphony is decided by the residual NSDF below, which
    // is the test that distinguishes a second NOTE from a noisy partial.
    if (detectCourse(points, fit.f1, fit.B)) gates.push('course');

    if (fit.rung === 'joint' && fit.B > 0 && midiHint !== null && !gates.length) {
      this.cachedB.set(midiHint, fit.B);
    }
    this.f1 = fit.f1;
    this.B = fit.B;

    // The chirp, in cents per second, robust across partials: they all chirp
    // together, since tension modulation moves the whole series.
    const rates = tracked.map((p) => (1200 / Math.LN2) * (p.chirp / p.freq));
    rates.sort((a, b) => a - b);
    const chirpCents = rates[Math.floor(rates.length / 2)];
    const chirpSpread = rates.length > 2
      ? (rates[rates.length - 1] - rates[0]) / (2 * Math.sqrt(rates.length))
      : Math.abs(chirpCents) * 0.3;

    let glide = this.glide.bound(chirpCents, Math.max(0.2, chirpSpread));
    // §8 wants theta from the FIRST partial's envelope. Higher partials decay
    // faster -- measured, 14 dB in 1.5 s while the fundamental loses 17 dB over
    // four -- so a theta taken from m = 2 or above reads short and the glide is
    // under-corrected. When the fundamental is not trackable (§2.3 says that is
    // common, not exceptional) the correction still runs, but its uncertainty
    // has to carry the substitution.
    if (this.envelopeM && this.envelopeM > 1 && glide.valid) {
      glide = { ...glide, sigmaD: Math.hypot(glide.sigmaD, 0.35 * glide.d) };
    }

    // sigma, combining exactly the terms DESIGN §10 lists as authoritative.
    // Admitted-bin SNR (§10 term 3). The per-partial phase-fit variance
    // already tracks SNR -- measured, it does so correctly -- so this is not a
    // second copy of it but a guard for the regime where the residual
    // understates the error: a partial barely clearing the mask, where the
    // interference is structured rather than Gaussian.
    const snrDb = 10 * Math.log10(Math.max(1, this.bestSnr || 1));
    const sigmaSnr = snrDb > 12 ? 0 : (12 - snrDb) * 0.08;
    const sigma = Math.sqrt(
      fit.sigmaCents * fit.sigmaCents +
      glide.sigmaD * glide.sigmaD +
      sigmaSnr * sigmaSnr +
      SIGMA_FLOOR * SIGMA_FLOOR
    );

    // Combine with the recent past (§ settle.js). The reference is held fixed
    // within a note so the combined series is of one quantity.
    const corrected = fit.f1 * Math.pow(2, -glide.d / 1200);
    if (!this.settleRef) this.settleRef = corrected;
    const relCents = 1200 * Math.log2(corrected / this.settleRef);
    const combined = this.settler.push(t, relCents, sigma);
    const finalFreq = this.settleRef * Math.pow(2, combined.cents / 1200);
    const finalSigma = Math.max(combined.sigma, SIGMA_FLOOR);

    return this._present(
      { fit, glide, sigma: finalSigma, chirpCents, partials: tracked.length, freq: finalFreq },
      gates, { t },
    );
  }

  _present(est, gates, { t }) {
    const hard = gates.find((g) => HARD_GATES.has(g)) || null;
    if (!est) {
      return {
        ...idleResult(),
        state: this.state,
        gates,
        hardGate: hard,
        heard: this.state !== STATE.QUIET,
        sinceOnset: t,
      };
    }
    const { fit, glide, sigma } = est;
    // d was SUBTRACTED upstream: the reading is always sharp of settled by d,
    // never flat by it, and a player who tunes until the number reads zero
    // would otherwise leave the string flat by d every single time.
    const corrected = est.freq;
    const note = nearestNote(corrected, this.a4);

    const inTune = Math.abs(note.cents) + 2 * sigma <= 3 && glide.d <= 0.3 && !hard;
    return {
      state: this.state,
      heard: true,
      sinceOnset: t,
      freq: corrected,
      rawFreq: fit.f1,
      note: note.name,
      octave: note.octave,
      midi: note.midi,
      cents: note.cents,
      sigma,
      d: glide.d,
      theta: glide.theta,
      chirp: est.chirpCents,
      B: fit.B,
      partials: est.partials,
      rung: fit.rung,
      gates,
      hardGate: hard,
      // Display policy (DESIGN §10). The interval rule is the point: anything
      // that displaces the true value from the reading goes INSIDE the
      // interval. A separate AND-clause does not compose with an interval test
      // -- this document made that mistake twice.
      showReading: sigma < 5 && !hard,
      inTune,
      confident: sigma < 1.5 && !hard,
    };
  }
}

function idleResult() {
  return {
    state: STATE.QUIET, heard: false, freq: null, note: null, octave: null,
    cents: null, sigma: null, d: 0, gates: [], hardGate: null,
    showReading: false, inTune: false, confident: false, sinceOnset: 0,
  };
}

function energy(w) { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * w[i]; return s; }
function endedRecently(now, last) { return last !== undefined && now - last < 8; }
const zeroNoise = new Float64Array(FRAME / 2 + 1);
