// Stitched sessions: the real recordings spliced into whole tuning sessions.
//
// This harness exists because every failure ever reported from actually using
// the tuner showed up here and nowhere else. Accuracy is not what it grades --
// the other two harnesses do that. It grades the things that make a tuner
// feel broken:
//
//   missed       a pluck that produced no reading at all
//   wrong        a reading naming a different string than the one played
//   ghost        a reading during a silence, when nothing is playing
//   jump         a frame-to-frame move of more than 8 cents inside one note
//   stuck        the tuner still naming the previous string after a new one
//
// The session includes the things that break state machines rather than
// estimators: re-plucks over a ringing note, string changes with no gap,
// silences of varying length, and an appliance that starts and stops partway
// through -- which is what was running the day the tuner last misbehaved.
//
//   node tools/session.mjs [seed] [sessions]
import fs from 'fs';
import path from 'path';
import { readWav } from './wav.mjs';
import { Engine } from '../src/dsp/engine.js';
import { makeRng } from './simulate.mjs';

const SEED = Number(process.argv[2]) || 1;
const SESSIONS = Number(process.argv[3]) || 6;
const DIR = 'samples';
const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'truth.json'), 'utf8'));
const STRINGS = ['e2', 'a2', 'd3', 'g3', 'b3', 'e4'];

const clips = {};
for (const s of STRINGS) {
  clips[s] = fs.readdirSync(DIR)
    .filter((f) => f.startsWith(`${s}-`) && f.endsWith('.wav') && !/pegturn/.test(f))
    .map((f) => ({ name: f, ...readWav(path.join(DIR, f)) }));
}
const roomTone = readWav(path.join(DIR, 'room-tone.wav'));

function buildSession(seed) {
  const rng = makeRng(seed);
  const sr = clips.e2[0].sampleRate;
  const parts = [];
  const marks = [];   // { from, to, string } in samples
  let at = 0;

  const push = (buf, str) => {
    if (str) marks.push({ from: at, to: at + buf.length, string: str });
    parts.push(buf);
    at += buf.length;
  };

  // Lead-in of real room tone: the app calibrates on this, as a user would.
  const lead = roomTone.samples.subarray(0, Math.round(sr * 3));
  push(lead, null);

  const order = [...STRINGS].sort(() => rng() - 0.5);
  for (const str of order) {
    const clip = clips[str][Math.floor(rng() * clips[str].length)];
    // A random slice containing at least one pluck, cut at a zero-ish point.
    const start = process.env.NO_CUT ? 0 : Math.round(sr * (0.5 + rng() * 1.5));
    const len = Math.round(sr * (2.5 + rng() * 4));
    const end = Math.min(clip.samples.length, start + len);
    push(clip.samples.subarray(start, end), str);
    // Sometimes no gap at all -- a new string over the last one still ringing.
    const gap = rng() < 0.35 ? 0 : Math.round(sr * (0.3 + rng() * 2.5));
    if (gap) push(roomTone.samples.subarray(0, Math.min(gap, roomTone.samples.length)), null);
  }

  const total = at;
  const session = new Float32Array(total);
  let off = 0;
  for (const p of parts) { session.set(p, off); off += p.length; }

  // The appliance: a broadband hum that starts a third of the way in and stops
  // two thirds of the way through, which is what a clothes dryer did to the
  // last version of this tuner.
  const onAt = Math.round(total * 0.33), offAt = Math.round(total * 0.66);
  // A real appliance is a motor harmonic series buried in broadband rumble,
  // and its motor frequency is not chosen to spare any particular string --
  // so it is randomised per session. Pinning it at 57 Hz, as an earlier
  // version did, put its second harmonic permanently on top of A2 and made
  // this test mostly a test of one coincidence.
  // Level it against the recording, not against an arbitrary constant. An
  // appliance in the room sits roughly 20-35 dB below a string you are holding
  // a phone next to; the first version of this file used a fixed amplitude
  // that worked out 10-20 dB down, which is louder than a dryer and was
  // quietly testing a condition no tuner is expected to survive.
  let noteRms = 0;
  for (let i = 0; i < total; i += 7) noteRms += session[i] * session[i];
  noteRms = Math.sqrt(noteRms / (total / 7));
  const downDb = 20 + rng() * 15;
  const hum = process.env.NO_APPLIANCE ? 0 : noteRms * Math.pow(10, -downDb / 20);
  const motor = 38 + rng() * 45;
  let lp = 0;
  for (let i = onAt; i < offAt; i++) {
    const t = i / sr;
    let v = 0;
    for (let h = 1; h <= 4; h++) v += (hum / h) * Math.sin(2 * Math.PI * motor * h * t + h);
    lp = 0.96 * lp + 0.04 * (rng() * 2 - 1);
    session[i] += v + hum * 2 * lp;
  }
  return { session, sampleRate: sr, marks, leadSamples: lead.length };
}

const totals = { plucks: 0, missed: 0, wrong: 0, ghost: 0, jump: 0, stuck: 0, readings: 0 };

for (let s = 0; s < SESSIONS; s++) {
  const { session, sampleRate, marks, leadSamples } = buildSession(SEED + s * 977);
  const engine = new Engine(sampleRate);
  const block = 512;

  // Calibrate on the lead-in, as the app does when the button is held.
  engine.beginCalibration();
  let at = 0;
  for (; at + block <= leadSamples; at += block) engine.push(session.subarray(at, at + block));
  engine.finishCalibration();

  const seen = marks.map(() => ({ readings: 0, right: 0, wrong: 0, heard: 0, gates: {}, maxSigma: 0 }));
  let ghost = 0, jump = 0, stuck = 0, prevCents = null, prevIdx = -1;

  for (; at + block <= session.length; at += block) {
    const r = engine.push(session.subarray(at, at + block));
    {
      const i2 = marks.findIndex((m) => at >= m.from && at < m.to + sampleRate * 0.35);
      if (i2 >= 0 && r.heard) {
        seen[i2].heard++;
        for (const g of r.gates || []) seen[i2].gates[g] = (seen[i2].gates[g] || 0) + 1;
        if (r.sigma) seen[i2].maxSigma = Math.max(seen[i2].maxSigma, r.sigma);
      }
    }
    if (!r.showReading || !r.freq) { prevCents = null; continue; }
    totals.readings++;

    const idx = marks.findIndex((m) => at >= m.from && at < m.to + sampleRate * 0.35);
    if (idx < 0) { ghost++; prevCents = null; continue; }

    const expected = truth[marks[idx].string].hz;
    const err = Math.abs(1200 * Math.log2(r.freq / expected));
    seen[idx].readings++;
    if (err < 60) seen[idx].right++;
    else {
      seen[idx].wrong++;
      // Is it the PREVIOUS string, still being named? That is a different and
      // more annoying failure than a random wrong answer.
      if (idx > 0 && Math.abs(1200 * Math.log2(r.freq / truth[marks[idx - 1].string].hz)) < 60) stuck++;
    }

    if (idx === prevIdx && prevCents !== null && Math.abs(r.cents - prevCents) > 8) jump++;
    prevCents = r.cents; prevIdx = idx;
  }

  if (process.env.VERBOSE) {
    seen.forEach((x, i) => {
      if (x.readings === 0) {
        console.log(`  MISSED ${marks[i].string}  heardFrames=${x.heard}  maxSigma=${x.maxSigma.toFixed(1)}  gates=${JSON.stringify(x.gates)}`);
      }
    });
  }
  totals.plucks += marks.length;
  totals.missed += seen.filter((x) => x.readings === 0).length;
  totals.wrong += seen.filter((x) => x.wrong > x.right).length;
  totals.ghost += ghost;
  totals.jump += jump;
  totals.stuck += stuck;
}

console.log(`${SESSIONS} stitched sessions, ${totals.plucks} string entries`);
console.log(`  missed (no reading at all)      ${totals.missed}`);
console.log(`  wrong string named              ${totals.wrong}`);
console.log(`  stuck on the previous string    ${totals.stuck} frames`);
console.log(`  ghost readings in silence       ${totals.ghost} frames`);
console.log(`  jumps > 8 cents within a note   ${totals.jump} of ${totals.readings} readings`);
const bad = totals.missed + totals.wrong;
console.log(`\n${bad === 0 && totals.ghost === 0 ? 'clean' : 'issues above'}`);
