// Scores the engine against the 32 real recordings.
//
// Ground truth comes from tools/measure-truth.mjs, which shares no code with
// the estimators: long windows contained wholly inside a note, partial-series
// fit. It is good to about +-1 cent with a known +0.85 cent bias that is
// uniform across strings, so it answers "did that change make it better?" and
// "does it behave on real audio?" -- but NOT "is sigma honest?" or "is R1 met
// in absolute terms". Those need the synthetic sweep (tools/sweep.mjs).
//
//   node tools/score.mjs [--save baseline.json] [--compare baseline.json]
import fs from 'fs';
import path from 'path';
import { readWav } from './wav.mjs';
import { Engine } from '../src/dsp/engine.js';

const DIR = 'samples';
const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'truth.json'), 'utf8'));
const cents = (a, b) => 1200 * Math.log2(a / b);

const files = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.wav') && /^[a-g]\d-/.test(f))
  .sort();

function run(file) {
  const { samples, sampleRate } = readWav(path.join(DIR, file));
  const string = file.split('-')[0];
  const ref = truth[string].hz;
  const engine = new Engine(sampleRate);
  const block = 512;

  const errs = [];
  const settled = [];
  const sigmas = [];
  const shown = [];
  const gates = new Map();
  let frames = 0, readings = 0, notes = 0, prevState = 'quiet', noteFrames = 0;
  const holdTimes = [];
  let heldFrom = null, lastReading = null;
  // Continuity: how many separate times the number appears and disappears
  // inside ONE note, and how long the breaks are.
  //
  // This is not an accuracy measure and no accuracy measure can see it. A
  // median hold time of 1.4 s is the same number whether the reading was one
  // steady span or five flashes with gaps between them, and the difference is
  // the whole experience of using the thing.
  const spans = [];
  let spanFrom = null, blinks = 0, gapList = [];
  let firstReadingAt = null, noteStartedAt = null;
  const ttf = [];
  let inTuneWrong = 0, inTuneTotal = 0;

  for (let at = 0; at + block <= samples.length; at += block) {
    const r = engine.push(samples.subarray(at, at + block));
    if (r === undefined) continue;
    frames++;
    const tNow = at / sampleRate;
    if (prevState === 'quiet' && r.state !== 'quiet') { notes++; noteStartedAt = tNow; firstReadingAt = null; }
    if (r.state === 'quiet') {
      if (heldFrom !== null && lastReading !== null) holdTimes.push(lastReading - heldFrom);
      if (spanFrom !== null) { spans.push(lastReading - spanFrom); spanFrom = null; }
      heldFrom = null; lastReading = null;
      prevState = 'quiet'; continue;
    }
    prevState = r.state;
    noteFrames++;
    for (const g of r.gates) gates.set(g, (gates.get(g) || 0) + 1);
    if (!r.showReading && spanFrom !== null) { spans.push(lastReading - spanFrom); spanFrom = null; }
    if (r.showReading && r.freq) {
      readings++;
      if (heldFrom === null) heldFrom = tNow;
      if (spanFrom === null) { spanFrom = tNow; if (lastReading !== null && tNow - lastReading < 1.0) { blinks++; gapList.push(tNow - lastReading); } }
      lastReading = tNow;
      const e = cents(r.freq, ref);
      errs.push(e);
      sigmas.push(r.sigma);
      shown.push({ t: tNow, e, sigma: r.sigma, d: r.d });
      if (firstReadingAt === null && noteStartedAt !== null) {
        firstReadingAt = tNow; ttf.push(tNow - noteStartedAt);
      }
      // What a player actually reads: the number after the glide has largely
      // gone. R1 is a statement about the SETTLED pitch.
      if (r.sinceOnset > 1.5) settled.push(e);
      if (r.inTune) { inTuneTotal++; if (Math.abs(e) > 3) inTuneWrong++; }
    }
  }
  return {
    file, string, ref, frames, readings, notes, errs, settled, sigmas, gates, ttf,
    inTuneTotal, inTuneWrong, noteFrames, pegturn: /pegturn/.test(file),
    holdTimes, spans, blinks, gapList,
  };
}

const q = (a, p) => { if (!a.length) return NaN; const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
const abs = (a) => a.map(Math.abs);

const rows = files.map(run);
let allErr = [], allSettled = [], allSigma = [], allTtf = [], allHold = [], allSpans = [], allGaps = [], totalGates = new Map();
let totalBlinks = 0;
let inTuneTotal = 0, inTuneWrong = 0, totalNotes = 0, coverage = 0, coverageFrames = 0;

console.log('file                    notes  reads   med|e|   p90|e|    max|e|   medSig   ttf');
for (const r of rows) {
  // Peg-turn takes are for glitch behaviour, not accuracy: the string is being
  // retuned, so truth.json's single settled frequency is simply not what is
  // sounding. Scoring them as accuracy would measure the wrong thing.
  if (!r.pegturn) { allErr = allErr.concat(r.errs); allSettled = allSettled.concat(r.settled); }
  allHold = allHold.concat(r.holdTimes);
  allSpans = allSpans.concat(r.spans);
  allGaps = allGaps.concat(r.gapList);
  totalBlinks += r.blinks;
  allSigma = allSigma.concat(r.sigmas);
  allTtf = allTtf.concat(r.ttf);
  for (const [g, n] of r.gates) totalGates.set(g, (totalGates.get(g) || 0) + n);
  inTuneTotal += r.inTuneTotal; inTuneWrong += r.inTuneWrong;
  totalNotes += r.notes; coverage += r.readings; coverageFrames += r.noteFrames;
  const ae = abs(r.errs);
  console.log(
    `${r.file.padEnd(22)} ${String(r.notes).padStart(5)} ${String(r.readings).padStart(6)}` +
    `  ${fmt(q(ae, 0.5))} ${fmt(q(ae, 0.9))} ${fmt(Math.max(0, ...ae))}` +
    `  ${fmt(q(r.sigmas, 0.5))}  ${r.ttf.length ? (q(r.ttf, 0.5) * 1000).toFixed(0) + 'ms' : '-'}`
  );
}
function fmt(v) { return Number.isFinite(v) ? v.toFixed(2).padStart(8) : '       -'; }

const ae = abs(allErr);
const as = abs(allSettled);
const summary = {
  files: rows.length,
  notes: totalNotes,
  readings: allErr.length,
  coverageOfNote: coverage / Math.max(1, coverageFrames),
  settledMedAbs: q(as, 0.5),
  settledP90Abs: q(as, 0.9),
  settledP99Abs: q(as, 0.99),
  medHoldS: q(allHold, 0.5),
  p10HoldS: q(allHold, 0.1),
  blinks: totalBlinks,
  spansUnder200ms: allSpans.filter((x) => x < 0.2).length,
  spans: allSpans.length,
  medSpanS: q(allSpans, 0.5),
  medAbsErr: q(ae, 0.5),
  p90AbsErr: q(ae, 0.9),
  p99AbsErr: q(ae, 0.99),
  maxAbsErr: Math.max(0, ...ae),
  medSigma: q(allSigma, 0.5),
  medTtfMs: q(allTtf, 0.5) * 1000,
  p90TtfMs: q(allTtf, 0.9) * 1000,
  inTuneClaims: inTuneTotal,
  inTuneViolations: inTuneWrong,
  gates: Object.fromEntries(totalGates),
};
console.log('\n--- reference quality (the ruler\'s own uncertainty) ---');
for (const [k, v] of Object.entries(truth)) {
  console.log(`  ${k}  ${v.hz.toFixed(3)} Hz   spread across windows ${v.spread.toFixed(2)} cents`);
}
console.log('  R7 is verified on tools/sweep.mjs, where the pitch is exact by construction.');
console.log('  A violation count here is only as good as the row above it.');

console.log('\n--- summary ---');
for (const [k, v] of Object.entries(summary)) {
  console.log(`  ${k.padEnd(18)} ${typeof v === 'number' ? v.toFixed(3) : JSON.stringify(v)}`);
}

const saveAt = process.argv.indexOf('--save');
if (saveAt > 0) fs.writeFileSync(process.argv[saveAt + 1], JSON.stringify(summary, null, 2));
const cmpAt = process.argv.indexOf('--compare');
if (cmpAt > 0 && fs.existsSync(process.argv[cmpAt + 1])) {
  const base = JSON.parse(fs.readFileSync(process.argv[cmpAt + 1], 'utf8'));
  console.log('\n--- vs baseline ---');
  for (const k of ['settledMedAbs', 'settledP90Abs', 'medAbsErr', 'p90AbsErr', 'maxAbsErr', 'coverageOfNote', 'medHoldS', 'blinks', 'spansUnder200ms', 'medSpanS', 'medTtfMs', 'inTuneViolations', 'notes']) {
    if (typeof base[k] !== 'number') continue;
    const d = summary[k] - base[k];
    const better = ['coverageOfNote', 'notes', 'medHoldS', 'medSpanS'].includes(k) ? d > 0 : d < 0;
    console.log(`  ${k.padEnd(18)} ${base[k].toFixed(3)} -> ${summary[k].toFixed(3)}  ${d === 0 ? '' : (better ? 'better' : 'WORSE')}`);
  }
}
