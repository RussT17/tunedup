// Independent ground truth. Shares the f1/B fit with the engine (which the
// sweep verifies exact: B ratio 1.00 median) but nothing else -- no tracking,
// no room model, no state machine, no glide correction. It gets its precision
// from brute force instead: a 65536-point window sitting wholly inside the
// sustained part of a note, so every partial is resolved to a fraction of a
// bin, averaged over several such windows.
//
//   node tools/measure-truth.mjs [--write]
import fs from 'fs';
import path from 'path';
import { readWav } from './wav.mjs';
import { FFT } from '../src/dsp/fft.js';
import { blackmanHarris } from '../src/dsp/window.js';
import { fitF1B, partialPlausible } from '../src/dsp/fit.js';

const N = 65536;
const DIR = 'samples';

function measure(file, seedHz) {
  const { samples, sampleRate } = readWav(path.join(DIR, file));
  const fft = new FFT(N);
  const win = blackmanHarris(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const binHz = sampleRate / N;

  // Find the loudest sustained stretch, then measure several windows inside it.
  const step = Math.round(sampleRate * 0.25);
  let best = -Infinity, bestAt = 0;
  for (let at = 0; at + N <= samples.length; at += step) {
    let s = 0;
    for (let i = 0; i < N; i += 8) s += samples[at + i] * samples[at + i];
    if (s > best) { best = s; bestAt = at; }
  }

  const results = [];
  for (const off of [-2, -1, 0, 1, 2]) {
    const at = bestAt + off * Math.round(sampleRate * 0.35);
    if (at < 0 || at + N > samples.length) continue;
    for (let i = 0; i < N; i++) re[i] = samples[at + i] * win[i];
    im.fill(0);
    fft.forward(re, im);
    const power = new Float64Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    // The ruler is told which string it is measuring; the engine is not. That
    // is the point of an independent reference -- removing the one question
    // (which octave?) that the thing under test has to answer for itself, so a
    // disagreement is about PRECISION and not about a period-finder.
    const f0 = refineSeed(power, binHz, seedHz);

    const floor = median(power.filter((_, k) => k * binHz > 60 && k * binHz < 4000));
    const points = [];
    for (let m = 1; m <= 20; m++) {
      const predicted = m * f0;
      if (predicted > 5000) break;
      const lo = Math.floor((predicted - f0 / 4) / binHz), hi = Math.ceil((predicted + f0 / 4) / binHz);
      let bk = -1, bv = 0;
      for (let k = lo; k <= hi; k++) {
        if (k < 1 || k + 1 >= power.length) continue;
        if (power[k] > bv && power[k] >= power[k - 1] && power[k] >= power[k + 1]) { bv = power[k]; bk = k; }
      }
      if (bk < 0 || bv < floor * 100) continue;
      const a = Math.log(power[bk - 1]), b = Math.log(power[bk]), c = Math.log(power[bk + 1]);
      const den = a - 2 * b + c;
      const freq = (bk + (den ? (0.5 * (a - c)) / den : 0)) * binHz;
      if (!partialPlausible(m, freq, f0, 60)) continue;
      // The window is 1.37 s long, so a bin is 0.73 Hz and a well-resolved
      // peak locates to a small fraction of that.
      points.push({ m, freq, sigmaHz: binHz / 20 });
    }
    if (points.length < 4) continue;
    const fit = fitF1B(points);
    if (fit) results.push(fit);
  }
  if (!results.length) return null;
  return {
    hz: median(results.map((r) => r.f1)),
    B: median(results.map((r) => r.B)),
    spread: 1200 * Math.log2(Math.max(...results.map((r) => r.f1)) / Math.min(...results.map((r) => r.f1))),
    windows: results.length,
  };
}

// Locate the true fundamental within a semitone of the nominal by looking at
// where the partial series lines up best.
function refineSeed(power, binHz, seedHz) {
  let best = seedHz, bestScore = -Infinity;
  for (let c = -60; c <= 60; c += 0.5) {
    const cand = seedHz * Math.pow(2, c / 1200);
    let score = 0;
    for (let m = 1; m <= 12; m++) {
      const k = Math.round((m * cand) / binHz);
      if (k < 2 || k + 2 >= power.length) break;
      let v = 0;
      for (let j = k - 1; j <= k + 1; j++) v = Math.max(v, power[j]);
      score += Math.log(v + 1e-30);
    }
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  return best;
}

function median(a) { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : NaN; }

const old = JSON.parse(fs.readFileSync(path.join(DIR, 'truth.json'), 'utf8'));
const out = {};
console.log('string   new hz     old hz    diff(c)   newB      oldB      spread  windows');
for (const str of ['e2', 'a2', 'd3', 'g3', 'b3', 'e4']) {
  const file = fs.readdirSync(DIR).find((f) => f.startsWith(`${str}-1-reference`));
  if (!file) continue;
  const m = measure(file, old[str].nominal);
  if (!m) { console.log(`${str}  FAILED`); continue; }
  const diff = 1200 * Math.log2(m.hz / old[str].hz);
  out[str] = { hz: m.hz, nominal: old[str].nominal, spread: m.spread, B: m.B };
  console.log(
    `${str.padEnd(8)} ${m.hz.toFixed(3).padStart(9)} ${old[str].hz.toFixed(3).padStart(10)} ${diff.toFixed(2).padStart(9)}` +
    `   ${m.B.toExponential(2)}  ${old[str].B.toExponential(2)}  ${m.spread.toFixed(2).padStart(6)}  ${m.windows}`);
}
if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(DIR, 'truth.json'), JSON.stringify(out, null, 2));
  console.log('\nwrote samples/truth.json');
}
