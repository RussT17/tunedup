/**
 * What this room sounds like when nothing is being played.
 *
 * A fixed high-pass assumes noise lives below the notes. That is usually true
 * and sometimes badly false — mains hum sits next to B2, a fan whine can land
 * on a partial, and a bass guitar's low B is below most rooms' rumble. So
 * instead of excluding bands by frequency, learn what each band normally does
 * and admit anything that rises well above its own baseline. Noise is
 * stationary; a plucked note is not, and that difference is measurable:
 * on a real recording the string's bands jump 30 dB while the room's rumble
 * band moves by 5.
 */

// Rooms are not perfectly steady — a measured rumble band wanders by about
// 6 dB on its own. The margin has to clear that, not just the median.
const MARGIN = 6;        // in power, ~8 dB
const RISE = 0.02;       // baseline climbs slowly...
const FALL = 0.15;       // ...and falls faster, so a stray sound does not stick
const READY_AFTER = 15;  // observations before the profile is worth using

export class RoomProfile {
  constructor(bins) {
    this.baseline = new Float64Array(bins);
    this.accumulator = new Float64Array(bins);
    this.observations = 0;
    this.calibrating = false;
    this.samples = 0;
    this.calibrated = false;
  }

  /** Begin an explicit calibration: the user has said nothing is playing. */
  beginCalibration() {
    this.accumulator.fill(0);
    this.samples = 0;
    this.calibrating = true;
  }

  /** Average of everything heard during calibration becomes the new baseline. */
  finishCalibration() {
    if (!this.samples) { this.calibrating = false; return false; }
    for (let i = 0; i < this.baseline.length; i++) {
      this.baseline[i] = this.accumulator[i] / this.samples;
    }
    this.observations = READY_AFTER;
    this.calibrating = false;
    this.calibrated = true;
    return true;
  }

  abandonCalibration() {
    this.calibrating = false;
    this.samples = 0;
  }

  /**
   * Fold one power spectrum into the profile.
   *
   * During calibration everything heard is the room, by the user's word, so it
   * is simply averaged. Afterwards the passive path may only ever *lower* the
   * baseline. That asymmetry matters: lowering it — the appliance stopped —
   * can only make the tuner more sensitive, while raising it risks masking a
   * string, which fails silently and stays failed. Rooms that get louder are
   * what the recalibrate button is for.
   */
  observe(power) {
    if (this.calibrating) {
      for (let i = 0; i < this.accumulator.length; i++) this.accumulator[i] += power[i];
      this.samples++;
      return;
    }
    const { baseline } = this;
    for (let i = 0; i < baseline.length; i++) {
      const value = power[i];
      if (this.observations === 0) baseline[i] = value;
      else if (value < baseline[i]) baseline[i] += (value - baseline[i]) * FALL;
      else if (!this.calibrated) baseline[i] += (value - baseline[i]) * RISE;
    }
    this.observations++;
  }

  get ready() {
    return this.observations >= READY_AFTER;
  }

  get progress() {
    return this.calibrating ? this.samples : 0;
  }

  /** Power a band must exceed to count as something being played. */
  threshold(bin) {
    return this.baseline[bin] * MARGIN;
  }

  /** True when this bin is carrying more than the room's own noise. */
  admits(bin, power) {
    return !this.ready || power > this.threshold(bin);
  }

  /** dB above baseline, for display and diagnostics. */
  excess(bin, power) {
    const floor = this.baseline[bin];
    return floor > 0 ? 10 * Math.log10(power / floor) : Infinity;
  }
}
