// Detector sanity check against synthetic tones: node tools/test-pitch.mjs
import { PitchDetector } from '../pitch.js';

const SR = 48000;
const N = 8192;
const TOLERANCE_CENTS = 2;
const detector = new PitchDetector(N);
const cents = (a, b) => 1200 * Math.log2(a / b);

// Deterministic noise so a run either always passes or always fails.
let seed = 12345;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function tone(freq, harmonics, noise = 0.01, skipFundamental = false) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let h = skipFundamental ? 2 : 1; h <= harmonics; h++) {
      v += (1 / h) * Math.sin((2 * Math.PI * freq * h * i) / SR + h);
    }
    buf[i] = 0.3 * v + noise * (random() * 2 - 1);
  }
  return buf;
}

let worst = 0;
let failures = 0;

for (const freq of [41.2, 65.41, 82.41, 110, 146.83, 196, 246.94, 329.63, 440, 523.25, 880]) {
  for (const harmonics of [1, 6, 14]) {
    for (const skip of [false, true]) {
      if (skip && harmonics === 1) continue;
      // Explicit range: the app defaults to the guitar band, but the detector
      // itself must stay correct wherever it is pointed.
      const { frequency } = detector.detect(tone(freq, harmonics, 0.01, skip), SR, { minFreq: 30 });
      const error = frequency ? cents(frequency, freq) : NaN;
      const ok = Math.abs(error) < TOLERANCE_CENTS;
      if (!ok) failures++;
      worst = Math.max(worst, Math.abs(error) || 0);
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${freq.toFixed(2).padStart(7)} Hz  harmonics=${String(harmonics).padStart(2)}` +
        `${skip ? ' (no fundamental)' : '                 '}  error=${error.toFixed(2)}c`
      );
    }
  }
}

const silence = detector.detect(new Float32Array(N), SR, { minFreq: 30 });
const noise = new Float32Array(N).map(() => 0.1 * (random() * 2 - 1));
const noiseResult = detector.detect(noise, SR, { minFreq: 30 });
for (const [label, result] of [['silence', silence], ['white noise', noiseResult]]) {
  const ok = result.frequency === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} reports no pitch`);
}

console.log(`\nworst error ${worst.toFixed(2)} cents, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
