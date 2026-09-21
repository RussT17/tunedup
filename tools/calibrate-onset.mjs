// Derives the onset threshold empirically, which DESIGN §6 and §12.5 require
// and which the design pointedly does NOT supply: "the onset threshold, which
// is currently absent rather than uncertain ... until it is, R4 cannot be
// implemented."
//
// Method: find plucks with an INDEPENDENT detector (a conservative broadband
// energy rise on the raw signal, which cannot miss a clear pluck and does not
// share any code with the statistic under test), then compare the engine's
// flux statistic inside a window around those plucks against its distribution
// everywhere else. A usable threshold is one with daylight between the two.
//
//   node tools/calibrate-onset.mjs
import fs from 'fs';
import path from 'path';
import { readWav } from './wav.mjs';
import { Engine } from '../src/dsp/engine.js';

const DIR = 'samples';
const files = fs.readdirSync(DIR).filter((f) => /^[a-g]\d-.*\.wav$/.test(f)).sort();

// Independent pluck finder: 10 ms RMS, rise of 14 dB within 40 ms, 200 ms
// refractory. Deliberately conservative -- it may miss soft plucks, which only
// makes the margin it reports pessimistic.
function findPlucks(samples, sr) {
  const win = Math.round(sr * 0.01);
  const rms = [];
  for (let at = 0; at + win <= samples.length; at += win) {
    let s = 0;
    for (let i = 0; i < win; i++) s += samples[at + i] * samples[at + i];
    rms.push(10 * Math.log10(s / win + 1e-20));
  }
  const out = [];
  let last = -1e9;
  for (let i = 4; i < rms.length; i++) {
    const rise = rms[i] - Math.min(rms[i - 4], rms[i - 3], rms[i - 2]);
    const t = (i * win) / sr;
    if (rise > 14 && rms[i] > -45 && t - last > 0.2) { out.push(t); last = t; }
  }
  return out;
}

const near = [], far = [];
const nearLevel = [], farLevel = [];
let plucks = 0;

for (const file of files) {
  const { samples, sampleRate } = readWav(path.join(DIR, file));
  const marks = findPlucks(samples, sampleRate);
  plucks += marks.length;
  const engine = new Engine(sampleRate);
  const seen = [];
  const oc = engine._onsetCheck.bind(engine);
  engine._onsetCheck = function (level, flux) {
    const h = this.levelHistory;
    const rise = h.length >= 6 ? level - Math.min(...h.slice(0, 3)) : 0;
    seen.push({ t: this.ring.end / sampleRate, flux, rise });
    return oc(level, flux);
  };
  const block = 512;
  for (let at = 0; at + block <= samples.length; at += block) engine.push(samples.subarray(at, at + block));

  // Per pluck, the PEAK of the statistic inside its detection window. The
  // question a threshold answers is "does every pluck produce one hop above
  // this?", not "is the average hop after a pluck above it" -- an onset is one
  // or two hops, and averaging them with the eight that follow understates it
  // by exactly that ratio.
  for (const m of marks) {
    let bestFlux = 0, bestLevel = -Infinity;
    for (const s of seen) {
      const dt = s.t - m;
      if (dt >= 0 && dt < 0.12) { bestFlux = Math.max(bestFlux, s.flux); bestLevel = Math.max(bestLevel, s.rise); }
    }
    if (Number.isFinite(bestLevel)) { near.push(bestFlux); nearLevel.push(bestLevel); }
  }
  for (const s of seen) {
    const d = Math.min(...marks.map((mm) => Math.abs(s.t - mm)), 1e9);
    if (d > 0.4) { far.push(s.flux); farLevel.push(s.rise); }
  }
}

const q = (a, p) => { const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
console.log(`${files.length} files, ${plucks} plucks found by the independent detector`);
console.log(`\nflux   per-pluck peak (n=${near.length})   min ${q(near, 0).toFixed(2)}  p10 ${q(near, 0.1).toFixed(2)}  p25 ${q(near, 0.25).toFixed(2)}  median ${q(near, 0.5).toFixed(2)}`);
console.log(`flux    background (n=${far.length})   median ${q(far, 0.5).toFixed(2)}  p90 ${q(far, 0.9).toFixed(2)}  p95 ${q(far, 0.95).toFixed(2)}  p99 ${q(far, 0.99).toFixed(2)}`);
console.log(`\nlevel  per-pluck peak   min ${q(nearLevel, 0).toFixed(2)}  p10 ${q(nearLevel, 0.1).toFixed(2)}  p25 ${q(nearLevel, 0.25).toFixed(2)}  median ${q(nearLevel, 0.5).toFixed(2)}`);
console.log(`level   background   p90 ${q(farLevel, 0.9).toFixed(2)}  p95 ${q(farLevel, 0.95).toFixed(2)}  p99 ${q(farLevel, 0.99).toFixed(2)}`);
const margin = q(near, 0.1) / Math.max(1e-3, q(far, 0.999));
console.log(`\nflux margin (weakest-decile pluck / background p99.9): ${margin.toFixed(1)}x`);
console.log(`suggested ONSET_FLUX: ${(Math.sqrt(Math.max(1e-3, q(near, 0.1)) * Math.max(1e-3, q(far, 0.999)))).toFixed(2)} dB (geometric mean of the two)`);
console.log(`suggested ONSET_LEVEL_DB: ${(Math.sqrt(Math.max(0.1, q(nearLevel, 0.1)) * Math.max(0.1, q(farLevel, 0.999)))).toFixed(2)} dB`);
