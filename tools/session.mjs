// A whole tuning session, stitched from the real recordings.
//
// Every other test is one note in isolation. This is the test for everything
// that happens *between* notes: strings played in sequence, re-plucks over a
// ringing string, long silences, and an appliance that runs for part of the
// session and then stops. It reports glitches rather than accuracy — notes
// missed, readings invented out of silence, wrong strings, and jumpiness.
//
//   node tools/session.mjs [seed] [--verbose]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Engine } from '../engine.js';
import { createEstimator, STRINGS } from '../estimators.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'samples');
const cents = (a, b) => 1200 * Math.log2(a / b);
const SR = 48000;

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function readWav(file) {
  const b = fs.readFileSync(file);
  const sampleRate = b.readUInt32LE(24);
  const n = (b.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { samples: out, sampleRate };
}

/** The loudest moment in a take, so notes can be spliced at their attack. */
function attackAt(samples, sampleRate) {
  const hop = Math.round(sampleRate * 0.02);
  let best = 0;
  let bestAt = 0;
  for (let at = 0; at + hop < samples.length; at += hop) {
    let sum = 0;
    for (let i = at; i < at + hop; i++) sum += samples[i] * samples[i];
    if (sum > best) { best = sum; bestAt = at; }
  }
  return Math.max(0, bestAt - Math.round(sampleRate * 0.08));
}

export function buildSession(seed = 1, options = {}) {
  const random = makeRandom(seed);
  const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
  const ids = Object.keys(truth);
  const takes = ['2-normal', '3-hard', '1-reference'];

  const room = readWav(path.join(dir, 'room-tone.wav')).samples;
  const total = Math.round((options.seconds || 70) * SR);
  const signal = new Float32Array(total);
  // Floor the whole session in the real room, looped.
  for (let i = 0; i < total; i++) signal[i] = room[i % room.length];

  // An appliance running for the first stretch and then stopping, which is the
  // case that broke a real session: the room the profile learned went away.
  const applianceEnds = Math.round((options.applianceSeconds ?? 28) * SR);
  let rumblePhase = 0;
  let lowpass = 0;
  for (let i = 0; i < applianceEnds; i++) {
    rumblePhase += (2 * Math.PI * 47) / SR;
    const hiss = (Math.random() * 2 - 1);
    lowpass += (hiss - lowpass) * 0.02;         // broadband, tilted low
    signal[i] += 0.010 * Math.sin(rumblePhase) + 0.008 * lowpass;
  }

  const events = [];
  let at = Math.round(1.5 * SR);
  while (at < total - 6 * SR) {
    const id = ids[Math.floor(random() * ids.length)];
    const take = takes[Math.floor(random() * takes.length)];
    let file = path.join(dir, `${id}-${take}.wav`);
    if (!fs.existsSync(file)) file = path.join(dir, `${id}-2-normal.wav`);
    const { samples } = readWav(file);
    const from = attackAt(samples, SR);
    // Sometimes let it ring out, sometimes cut in with the next note early.
    const holdFor = Math.round((1.2 + random() * 4) * SR);
    const length = Math.min(samples.length - from, holdFor);
    for (let i = 0; i < length && at + i < total; i++) signal[at + i] += samples[from + i];
    events.push({ id, take, at: at / SR, truth: truth[id].hz, length: length / SR });
    // Gap: often a pause, sometimes immediately on top of the previous note.
    at += length + Math.round((random() < 0.3 ? 0.05 : 0.4 + random() * 2.5) * SR);
  }
  return { signal, events, applianceEnds: applianceEnds / SR };
}

export function runSession(modeId, signal, target = null, options = {}) {
  const { calibrate = true } = options;
  const engine = new Engine(SR);
  engine.setTarget(target);
  const estimator = createEstimator(modeId, { sampleRate: SR, engine, targetHz: () => target });
  const tick = Math.round(SR * 0.04);
  let next = tick;
  const frames = [];
  // A real session begins with the user holding the calibrate button while the
  // room — appliance and all — is measured.
  if (calibrate) engine.beginCalibration();
  let calibrated = !calibrate;
  for (let offset = 0; offset < signal.length; offset += 1024) {
    engine.push(signal.subarray(offset, Math.min(offset + 1024, signal.length)));
    while (engine.written >= next) {
      const frame = engine.analyse();
      if (!calibrated) {
        if (frame.calibrationProgress >= 50) { engine.finishCalibration(); calibrated = true; }
        next += tick;
        continue;
      }
      frames.push({ frame, reading: estimator.update(frame) });
      next += tick;
    }
  }
  return frames;
}

export function grade(frames, events, applianceEnds) {
  const report = {
    played: events.length,
    recognised: 0,
    slow: 0,
    timeToRead: [],
    wrongNote: 0,
    inventedInSilence: 0,
    worstJump: 0,
    jumpsOverFive: 0,
    duringAppliance: { recognised: 0, played: 0 },
  };

  // A reading belongs to whichever note was most recently played.
  const noteAt = (t) => {
    let current = null;
    for (const e of events) {
      if (e.at <= t && t < e.at + e.length + 1.5) current = e;
    }
    return current;
  };

  for (const event of events) {
    const window = frames.filter((f) => f.frame.time >= event.at && f.frame.time < event.at + Math.min(event.length, 3));
    const read = window.find((f) => f.reading.status === 'live' && f.reading.frequency);
    if (event.at < applianceEnds) report.duringAppliance.played++;
    if (read) {
      report.recognised++;
      if (event.at < applianceEnds) report.duringAppliance.recognised++;
      const delay = read.frame.time - event.at;
      report.timeToRead.push(delay);
      if (delay > 1.2) report.slow++;
    }
  }

  let previous = null;
  for (const f of frames) {
    const { frame, reading } = f;
    if (reading.status !== 'live' || !reading.frequency) { previous = null; continue; }
    const owner = noteAt(frame.time);
    if (!owner) {
      report.inventedInSilence++;
    } else if (Math.abs(cents(reading.frequency, owner.truth)) > 150) {
      report.wrongNote++;
    }
    if (previous && frame.time - previous.time < 0.1) {
      const jump = Math.abs(cents(reading.frequency, previous.frequency));
      report.worstJump = Math.max(report.worstJump, jump);
      if (jump > 5) report.jumpsOverFive++;
    }
    previous = { time: frame.time, frequency: reading.frequency };
  }
  return report;
}

if (process.argv[1] && process.argv[1].endsWith('session.mjs')) {
  const seed = Number(process.argv[2] || 7);
  const { signal, events, applianceEnds } = buildSession(seed);
  console.log(`Stitched session: ${events.length} notes over ${(signal.length / SR).toFixed(0)}s, ` +
    `appliance running for the first ${applianceEnds.toFixed(0)}s\n`);
  console.log('  mode        heard   missed   slow   wrong   invented   jumps>5c  worst   with appliance');
  for (const mode of ['standard', 'sustain', 'predict', 'strobe', 'studio']) {
    const frames = runSession(mode, signal);
    const r = grade(frames, events, applianceEnds);
    const median = r.timeToRead.sort((a, b) => a - b)[r.timeToRead.length >> 1];
    console.log(
      `  ${mode.padEnd(10)} ${String(r.recognised).padStart(3)}/${r.played}  ` +
      `${String(r.played - r.recognised).padStart(5)}  ${String(r.slow).padStart(5)}  ` +
      `${String(r.wrongNote).padStart(5)}  ${String(r.inventedInSilence).padStart(8)}  ` +
      `${String(r.jumpsOverFive).padStart(8)}  ${(r.worstJump || 0).toFixed(0).padStart(5)}c  ` +
      `${String(r.duringAppliance.recognised).padStart(6)}/${r.duringAppliance.played}` +
      `   first read ${median ? median.toFixed(2) : '—'}s`
    );
  }
}
