// One number for "did that change make it better?".
//
//   node tools/score.mjs            score real samples and the sweep
//   node tools/score.mjs --save     also write the result as the new baseline
//
// Real recordings say whether it works on an actual guitar; the randomised
// sweep says whether it works on anything else. A change that moves one up and
// the other down is the shape overfitting takes.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Engine } from '../engine.js';
import { createEstimator, MODES, STRINGS } from '../estimators.js';
import { measureRobust } from './measure-truth.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const samples = path.join(root, 'samples');
const cents = (a, b) => 1200 * Math.log2(a / b);
const REFERENCE = 440;
const STRING_IDS = ['e2', 'a2', 'd3', 'g3', 'b3', 'e4'];
// Single-pluck takes only: a re-pluck recording has several notes and no single
// settled pitch to be scored against.
const TAKES = ['1-reference', '2-normal', '3-hard'];

function readWav(file) {
  const b = fs.readFileSync(file);
  const sampleRate = b.readUInt32LE(24);
  const n = (b.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { samples: out, sampleRate };
}

/** Truth per string, measured once from the soft reference pluck and cached. */
function groundTruth() {
  const cache = path.join(samples, 'truth.json');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const truth = {};
  for (const id of STRING_IDS) {
    const string = STRINGS.find((s) => s.id === id);
    const nominal = REFERENCE * Math.pow(2, (string.midi - 69) / 12);
    const file = path.join(samples, `${id}-1-reference.wav`);
    if (!fs.existsSync(file)) continue;
    const measured = measureRobust(file, nominal);
    if (measured) truth[id] = { hz: measured.f1, nominal, spread: measured.spread, B: measured.B };
  }
  fs.writeFileSync(cache, JSON.stringify(truth, null, 2));
  return truth;
}

function run(modeId, signal, sampleRate, target) {
  const engine = new Engine(sampleRate);
  engine.setTarget(target);
  const estimator = createEstimator(modeId, { sampleRate, engine, targetHz: () => target });
  const tick = Math.round(sampleRate * 0.04);
  let next = tick;
  const readings = [];
  for (let offset = 0; offset < signal.length; offset += 1024) {
    engine.push(signal.subarray(offset, Math.min(offset + 1024, signal.length)));
    while (engine.written >= next) {
      const frame = engine.analyse();
      readings.push({ frame, reading: estimator.update(frame) });
      next += tick;
    }
  }
  return readings;
}

const quantile = (values, q) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const show = (v) => (Number.isNaN(v) ? '   — ' : v.toFixed(1).padStart(5));

const truth = groundTruth();
const results = {};

console.log('REAL SAMPLES — error against ground truth from the reference pluck\n');
console.log('  mode        |err| @1s        @2s        @3s     tracked  worst');
console.log('              med   p90   med   p90   med   p90     med    jump');
for (const mode of MODES) {
  const stat = { at1: [], at2: [], at3: [], held: [], jump: [] };
  for (const id of STRING_IDS) {
    if (!truth[id]) continue;
    const string = STRINGS.find((s) => s.id === id);
    const target = REFERENCE * Math.pow(2, (string.midi - 69) / 12);
    for (const take of TAKES) {
      const file = path.join(samples, `${id}-${take}.wav`);
      if (!fs.existsSync(file)) continue;
      const { samples: signal, sampleRate } = readWav(file);
      const readings = run(mode.id, signal, sampleRate, target);
      const live = readings.filter((e) => e.reading.status === 'live' && e.reading.frequency && e.frame.onsetAge !== null);
      if (!live.length) continue;
      const at = (t) => {
        const hit = live.filter((e) => e.frame.onsetAge <= t);
        return hit.length ? Math.abs(cents(hit[hit.length - 1].reading.frequency, truth[id].hz)) : null;
      };
      for (const [key, value] of [['at1', at(1)], ['at2', at(2)], ['at3', at(3)]]) {
        if (value !== null && value < 300) stat[key].push(value);
      }
      stat.held.push(live[live.length - 1].frame.onsetAge);
      let worst = 0;
      for (let k = 1; k < live.length; k++) {
        if (live[k].frame.onsetAge < 1) continue;
        worst = Math.max(worst, Math.abs(cents(live[k].reading.frequency, live[k - 1].reading.frequency)));
      }
      stat.jump.push(worst);
    }
  }
  results[mode.id] = {
    at2: quantile(stat.at2, 0.5),
    p90: quantile(stat.at2, 0.9),
    held: quantile(stat.held, 0.5),
    jump: quantile(stat.jump, 0.9),
  };
  console.log(
    `  ${mode.label.padEnd(10)} ${show(quantile(stat.at1, 0.5))} ${show(quantile(stat.at1, 0.9))} ` +
    `${show(quantile(stat.at2, 0.5))} ${show(quantile(stat.at2, 0.9))} ` +
    `${show(quantile(stat.at3, 0.5))} ${show(quantile(stat.at3, 0.9))} ` +
    `${show(quantile(stat.held, 0.5))}s ${show(quantile(stat.jump, 0.9))}c`
  );
}

console.log('\n');
console.log(execFileSync(process.execPath, [path.join(root, 'tools', 'sweep.mjs'), '40'], { encoding: 'utf8' }).trim());

const baseline = path.join(root, 'tools', 'baseline.json');
if (process.argv.includes('--save')) {
  fs.writeFileSync(baseline, JSON.stringify(results, null, 2));
  console.log('\n  baseline saved');
} else if (fs.existsSync(baseline)) {
  const previous = JSON.parse(fs.readFileSync(baseline, 'utf8'));
  console.log('\nCHANGE vs baseline (real samples, error at 2 s, negative is better)\n');
  for (const mode of MODES) {
    const now = results[mode.id];
    const before = previous[mode.id];
    if (!before || Number.isNaN(now.at2) || Number.isNaN(before.at2)) continue;
    const delta = now.at2 - before.at2;
    const mark = Math.abs(delta) < 0.2 ? ' ' : delta < 0 ? '↓' : '↑';
    console.log(`  ${mode.label.padEnd(10)} ${before.at2.toFixed(1)} → ${now.at2.toFixed(1)} cents  ${mark}`);
  }
}
