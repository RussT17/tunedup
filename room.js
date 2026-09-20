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
    this.observations = 0;
  }

  /** Fold one power spectrum of near-silence into the baseline. */
  observe(power) {
    const { baseline } = this;
    for (let i = 0; i < baseline.length; i++) {
      const value = power[i];
      if (this.observations === 0) baseline[i] = value;
      else baseline[i] += (value - baseline[i]) * (value > baseline[i] ? RISE : FALL);
    }
    this.observations++;
  }

  get ready() {
    return this.observations >= READY_AFTER;
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
