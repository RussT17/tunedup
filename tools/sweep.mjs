// The synthetic sweep: absolute accuracy and the sigma reliability diagram.
//
// DESIGN §10 and §13 are emphatic that sigma must be calibrated HERE and not on
// the real recordings: the sweep's pitch is exact by construction, while the
// recordings' ground truth is only +-1 cent. Testing a sub-cent sigma against a
// +-1 cent reference measures mostly the reference -- a true sigma of 0.2 would
// show a realised error of sqrt(0.2^2 + 1^2) = 1.02 and appear to demand a
// FIVE-FOLD inflation. Applied, that would push most readings past both
// sigma < 5 and the in-tune interval, and the tuner would show note names where
// it should show numbers.
//
//   node tools/sweep.mjs [takes]
import { Engine } from '../src/dsp/engine.js';
import { synthNote, randomTake } from './simulate.mjs';

const TAKES = Number(process.argv[2]) || 120;
const SR = 48000;

const rows = [];
let claims = 0, violations = 0, noReading = 0;

for (let i = 1; i <= TAKES; i++) {
  const take = randomTake(i);
  const audio = synthNote({ sampleRate: SR, duration: 6, startAt: 1.2, ...take });
  const engine = new Engine(SR);
  const block = 512;
  let got = 0;
  for (let at = 0; at + block <= audio.length; at += block) {
    const r = engine.push(audio.subarray(at, at + block));
    const t = at / SR;
    if (t < 1.2) continue;
    if (!r.showReading || !r.freq) continue;
    got++;
    const err = 1200 * Math.log2(r.freq / take.f1);
    rows.push({ t: t - 1.2, err, sigma: r.sigma, d: r.d, inTune: r.inTune, take: i, B: r.B, trueB: take.B });
    if (r.inTune) { claims++; if (Math.abs(err) > 3) violations++; }
  }
  if (!got) noReading++;
}

const q = (a, p) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN; };
const errs = rows.map((r) => Math.abs(r.err));
const signed = rows.map((r) => r.err);

console.log(`${TAKES} takes, ${rows.length} readings, ${noReading} takes with no reading at all`);
console.log(`\nabsolute error   median ${q(errs, 0.5).toFixed(2)}  p90 ${q(errs, 0.9).toFixed(2)}  p99 ${q(errs, 0.99).toFixed(2)}  max ${Math.max(...errs).toFixed(2)}`);
console.log(`signed error     median ${q(signed, 0.5).toFixed(2)}  (a systematic offset here is a BIAS, not noise)`);

// Settled-only: after 2 s, which is what a player actually reads.
const late = rows.filter((r) => r.t > 2);
const lateErr = late.map((r) => Math.abs(r.err));
console.log(`after 2 s        median ${q(lateErr, 0.5).toFixed(2)}  p90 ${q(lateErr, 0.9).toFixed(2)}  p99 ${q(lateErr, 0.99).toFixed(2)}   (n=${late.length})`);

console.log('\n--- reliability diagram: is sigma honest? ---');
console.log('sigma bin        n     p50|e|   p99|e|   p99/sigma   max|e|/sigma');
const bins = [[0, 0.3], [0.3, 0.6], [0.6, 1], [1, 2], [2, 3.5], [3.5, 5]];
let worstRatio = 0;
for (const [lo, hi] of bins) {
  const sel = rows.filter((r) => r.sigma >= lo && r.sigma < hi);
  if (sel.length < 20) { console.log(`${lo}-${hi}`.padEnd(14) + String(sel.length).padStart(6) + '   (too few)'); continue; }
  const e = sel.map((r) => Math.abs(r.err));
  const ratios = sel.map((r) => Math.abs(r.err) / r.sigma);
  const p99r = q(ratios, 0.99), maxr = Math.max(...ratios);
  worstRatio = Math.max(worstRatio, maxr);
  console.log(`${lo}-${hi}`.padEnd(14) + String(sel.length).padStart(6) +
    `   ${q(e, 0.5).toFixed(2).padStart(6)}  ${q(e, 0.99).toFixed(2).padStart(6)}` +
    `   ${p99r.toFixed(2).padStart(8)}   ${maxr.toFixed(2).padStart(10)}`);
}
console.log(`\nConservative at p99 requires p99/sigma <= 2.58 in every bin.`);
console.log(`Worst |error|/sigma anywhere: ${worstRatio.toFixed(2)}  (R7 forbids a single catastrophic ratio, which a percentile hides)`);
console.log(`\nR7: ${claims} in-tune claims, ${violations} of them beyond 3 cents  ${violations === 0 ? 'OK' : '*** VIOLATION ***'}`);

const bErr = rows.filter((r) => r.B > 0).map((r) => r.B / r.trueB);
if (bErr.length) console.log(`B ratio (fitted/true)  median ${q(bErr, 0.5).toFixed(2)}  p10 ${q(bErr, 0.1).toFixed(2)}  p90 ${q(bErr, 0.9).toFixed(2)}`);
