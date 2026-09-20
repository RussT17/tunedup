import { PitchDetector } from './pitch.js';
import { RoomProfile } from './room.js';

// Shared front end for every tuning mode: keeps a ring buffer of contiguous
// audio, tracks the noise floor and note onsets, and runs one MPM pitch
// estimate per tick. Estimators consume the resulting frames.

const RING_BITS = 17;            // 131072 samples — 2.7 s, covers the longest baseline
const WINDOW_SIZE = 8192;        // ~170 ms, enough periods for a low B string
const ENVELOPE_SECONDS = 0.025;
const TAPE_SECONDS = 18;         // raw audio kept for export, with headroom
                                 // so a 15 s capture cannot be overwritten mid-save
// Only DC and subsonic handling noise are filtered by frequency. Room noise is
// dealt with by RoomProfile, which judges each band against what that band
// normally does — so a low note is kept where a steady rumble at the same
// frequency is dropped, and nothing below the lowest string is excluded on
// principle.
const HIGHPASS_HZ = 28;
const HIGHPASS_STAGES = 1;
const LOWPASS_HZ = 3500;         // hiss above anything musical
const SEARCH_MARGIN_CENTS = 400; // how far either side of a chosen string to look

/** RBJ biquad, held as persistent state so blocks join without a transient. */
function biquad(type, frequency, sampleRate, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
  } else {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
  }
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0,
    x1: 0, x2: 0, y1: 0, y2: 0,
  };
}

function step(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x;
  f.y2 = f.y1; f.y1 = y;
  return y;
}

export class Engine {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    // Analysis runs on filtered audio; the tape keeps the raw input, so an
    // exported recording is the microphone's own signal and a replay can try
    // different filtering rather than being stuck with today's choice.
    this.ring = new Float32Array(1 << RING_BITS);
    this.ringMask = this.ring.length - 1;
    this.written = 0;
    this.tape = new Float32Array(Math.round(TAPE_SECONDS * sampleRate));
    this.taped = 0;
    this.lowpass = biquad('lowpass', LOWPASS_HZ, sampleRate);
    this.setTarget(null);

    this.detector = new PitchDetector(WINDOW_SIZE);
    this.window = new Float32Array(WINDOW_SIZE);
    this.room = new RoomProfile(this.detector.fftSize >> 1);

    this.noiseFloor = 0.002;
    this.onsetSample = -1;
    this.aboveGateSince = -1;
    this.quietSince = -1;
    this.onsetId = 0;
    this.peakRms = 0;
  }

  /**
   * Point the front end at a known string, or at the whole guitar range. With a
   * target the high-pass can sit far higher and the pitch search shrinks to a
   * few semitones, which is what makes a quiet string on a noisy floor readable.
   */
  setTarget(targetHz) {
    const cutoff = targetHz
      ? Math.min(400, Math.max(45, targetHz * 0.7))
      : HIGHPASS_HZ;
    this.highpass = [];
    for (let i = 0; i < HIGHPASS_STAGES; i++) {
      this.highpass.push(biquad('highpass', cutoff, this.sampleRate));
    }
    const margin = Math.pow(2, SEARCH_MARGIN_CENTS / 1200);
    this.minFreq = targetHz ? targetHz / margin : 27.5;
    this.maxFreq = targetHz ? targetHz * margin : 2100;
  }

  push(block) {
    const { ring, ringMask, tape } = this;
    for (let i = 0; i < block.length; i++) {
      const raw = block[i];
      tape[(this.taped + i) % tape.length] = raw;
      let filtered = raw;
      for (const stage of this.highpass) filtered = step(stage, filtered);
      ring[(this.written + i) & ringMask] = step(this.lowpass, filtered);
    }
    this.written += block.length;
    this.taped += block.length;
  }

  /** Copies `target.length` samples ending at `endSample`. False if they have scrolled out. */
  read(target, endSample = this.written) {
    const start = endSample - target.length;
    if (start < 0 || endSample > this.written || this.written - start > this.ring.length) return false;
    for (let i = 0; i < target.length; i++) target[i] = this.ring[(start + i) & this.ringMask];
    return true;
  }

  /** Raw audio between two absolute tape positions, clipped to what is still held. */
  tapeSlice(from, to) {
    const end = Math.min(to, this.taped);
    const start = Math.max(from, 0, end - this.tape.length);
    const count = Math.max(0, end - start);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.tape[(start + i) % this.tape.length];
    return out;
  }

  rms(sampleCount, endSample = this.written) {
    const start = Math.max(0, endSample - sampleCount);
    if (endSample > this.written || this.written - start > this.ring.length) return 0;
    let sum = 0;
    for (let n = start; n < endSample; n++) {
      const v = this.ring[n & this.ringMask];
      sum += v * v;
    }
    const count = endSample - start;
    return count ? Math.sqrt(sum / count) : 0;
  }

  /** One analysis tick. Returns the frame every estimator works from. */
  analyse() {
    const sr = this.sampleRate;
    const envelope = Math.round(sr * ENVELOPE_SECONDS);
    const rms = this.rms(envelope);
    const previous = this.rms(envelope, this.written - envelope);

    // Fast down, slow up, and never upward while a note is ringing — otherwise
    // a long sustain drags the floor up and gates itself off.
    const sounding = this.onsetSample >= 0;
    if (rms < this.noiseFloor) this.noiseFloor += (rms - this.noiseFloor) * 0.25;
    else if (!sounding) this.noiseFloor += (rms - this.noiseFloor) * 0.0015;
    this.noiseFloor = Math.max(this.noiseFloor, 2e-5);

    const gate = Math.max(this.noiseFloor * 3.5, 0.0012);
    this.aboveGateSince = rms > gate ? (this.aboveGateSince < 0 ? this.written : this.aboveGateSince) : -1;

    // Pitch first: whether the detector can still hear a note is part of
    // deciding whether the note is over.
    let frequency = 0;
    let clarity = 0;
    if (this.read(this.window)) {
      // Learn the room whenever nothing is being played; judge against it
      // whenever something is.
      const quietEnoughToLearn = !sounding && rms < Math.max(this.noiseFloor * 2, 0.0015);
      const result = this.detector.detect(this.window, sr, {
        minRms: Math.max(this.noiseFloor * 2, 0.0008),
        minFreq: this.minFreq,
        maxFreq: this.maxFreq,
        room: this.room,
        learnRoom: quietEnoughToLearn,
      });
      frequency = result.frequency;
      clarity = result.clarity;
    }

    const isOnset = rms > gate * 1.5 && rms > previous * 1.7 &&
      (!sounding || (this.written - this.onsetSample) / sr > 0.15);

    if (isOnset) {
      this.onsetSample = this.written - envelope;
      this.peakRms = rms;
      this.quietSince = -1;
      this.onsetId++;
    } else if (!sounding && this.aboveGateSince >= 0 &&
               (this.written - this.aboveGateSince) / sr > 0.4) {
      // Something was already ringing when we started listening (or the attack
      // was too gradual to trip the onset test). Treat it as a note in progress
      // rather than never showing a reading.
      this.onsetSample = this.aboveGateSince;
      this.peakRms = Math.max(this.peakRms, rms);
      this.quietSince = -1;
      this.onsetId++;
    } else if (sounding) {
      if (rms > this.peakRms) this.peakRms = rms;
      // A note ends when it is both too quiet to measure and no longer
      // periodic, and stays that way. Ending it on level alone cut soft
      // strings off while the detector could still read them perfectly well.
      const quiet = rms < Math.max(this.noiseFloor * 1.8, this.peakRms * 0.008);
      if (quiet && clarity < 0.6) {
        if (this.quietSince < 0) this.quietSince = this.written;
        if ((this.written - this.quietSince) / sr > 0.25) {
          this.onsetSample = -1;
          this.quietSince = -1;
        }
      } else {
        this.quietSince = -1;
      }
    }

    return {
      sample: this.written,
      time: this.written / sr,
      rms,
      noiseFloor: this.noiseFloor,
      peakRms: this.peakRms,
      onsetId: this.onsetId,
      onsetAge: this.onsetSample >= 0 ? (this.written - this.onsetSample) / sr : null,
      f0: frequency,
      clarity,
    };
  }
}
