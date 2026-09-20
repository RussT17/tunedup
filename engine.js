import { PitchDetector } from './pitch.js';

// Shared front end for every tuning mode: keeps a ring buffer of contiguous
// audio, tracks the noise floor and note onsets, and runs one MPM pitch
// estimate per tick. Estimators consume the resulting frames.

const RING_BITS = 20;            // ~1M samples — 21 s at 48 kHz, enough to export a pluck
const WINDOW_SIZE = 8192;        // ~170 ms, enough periods for a low B string
const ENVELOPE_SECONDS = 0.025;

export class Engine {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.ring = new Float32Array(1 << RING_BITS);
    this.ringMask = this.ring.length - 1;
    this.written = 0;

    this.detector = new PitchDetector(WINDOW_SIZE);
    this.window = new Float32Array(WINDOW_SIZE);

    this.noiseFloor = 0.002;
    this.onsetSample = -1;
    this.aboveGateSince = -1;
    this.onsetId = 0;
    this.peakRms = 0;
  }

  push(block) {
    const { ring, ringMask } = this;
    for (let i = 0; i < block.length; i++) ring[(this.written + i) & ringMask] = block[i];
    this.written += block.length;
  }

  /** Copies `target.length` samples ending at `endSample`. False if they have scrolled out. */
  read(target, endSample = this.written) {
    const start = endSample - target.length;
    if (start < 0 || endSample > this.written || this.written - start > this.ring.length) return false;
    for (let i = 0; i < target.length; i++) target[i] = this.ring[(start + i) & this.ringMask];
    return true;
  }

  /** The most recent `seconds` of audio, for exporting a recording. */
  snapshot(seconds) {
    const count = Math.min(Math.round(seconds * this.sampleRate), this.ring.length, this.written);
    const out = new Float32Array(count);
    const start = this.written - count;
    for (let i = 0; i < count; i++) out[i] = this.ring[(start + i) & this.ringMask];
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

    const isOnset = rms > gate * 1.5 && rms > previous * 2 &&
      (!sounding || (this.written - this.onsetSample) / sr > 0.15);

    if (isOnset) {
      this.onsetSample = this.written - envelope;
      this.peakRms = rms;
      this.onsetId++;
    } else if (!sounding && this.aboveGateSince >= 0 &&
               (this.written - this.aboveGateSince) / sr > 0.4) {
      // Something was already ringing when we started listening (or the attack
      // was too gradual to trip the onset test). Treat it as a note in progress
      // rather than never showing a reading.
      this.onsetSample = this.aboveGateSince;
      this.peakRms = Math.max(this.peakRms, rms);
      this.onsetId++;
    } else if (sounding) {
      if (rms > this.peakRms) this.peakRms = rms;
      // A note is over once it falls back into the noise, not at a fixed level:
      // an unplugged electric decays a long way below a fixed threshold.
      if (rms < Math.max(this.noiseFloor * 2.5, this.peakRms * 0.015)) this.onsetSample = -1;
    }

    let frequency = 0;
    let clarity = 0;
    if (this.read(this.window)) {
      const result = this.detector.detect(this.window, sr, Math.max(this.noiseFloor * 2, 0.0008));
      frequency = result.frequency;
      clarity = result.clarity;
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
