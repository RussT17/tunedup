// Replays a real recording through every mode. Run:
//   node tools/analyse-wav.mjs recording.wav [--string e2] [--ref 440]
//
// Writes <recording>-trace.html alongside the input so the trace can be viewed.
import fs from 'fs';
import path from 'path';
import { Engine } from '../engine.js';
import { createEstimator, MODES, STRINGS } from '../estimators.js';
import { renderTrace } from '../trace.js';

const cents = (a, b) => 1200 * Math.log2(a / b);

function readWav(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        code: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    offset = body + size + (size % 2);
  }
  if (!format || !data) throw new Error('missing fmt or data chunk');

  const { channels, bits, code } = format;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * bytes;
      if (code === 3 && bits === 32) sum += data.readFloatLE(at);
      else if (bits === 16) sum += data.readInt16LE(at) / 32768;
      else if (bits === 32) sum += data.readInt32LE(at) / 2147483648;
      else if (bits === 8) sum += (data.readUInt8(at) - 128) / 128;
      else throw new Error(`unsupported bit depth ${bits}`);
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate: format.sampleRate };
}

function run(modeId, samples, sampleRate, target) {
  const engine = new Engine(sampleRate);
  const estimator = createEstimator(modeId, { sampleRate, engine, targetHz: () => target });
  const tick = Math.round(sampleRate * 0.04);
  let next = tick;
  const readings = [];
  for (let offset = 0; offset < samples.length; offset += 1024) {
    engine.push(samples.subarray(offset, Math.min(offset + 1024, samples.length)));
    while (engine.written >= next) {
      const frame = engine.analyse();
      const reading = estimator.update(frame);
      readings.push({ frame, reading, fit: estimator.fitInfo() });
      next += tick;
    }
  }
  return readings;
}

/** Splits the run into notes, so a recording of several plucks reports each one. */
function notes(readings) {
  const out = [];
  let current = null;
  for (const entry of readings) {
    const { frame } = entry;
    if (frame.onsetAge === null) { current = null; continue; }
    if (!current || current.onsetId !== frame.onsetId) {
      current = { onsetId: frame.onsetId, entries: [] };
      out.push(current);
    }
    current.entries.push(entry);
  }
  return out.filter((n) => n.entries.length > 8);
}

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/analyse-wav.mjs recording.wav [--string e2] [--ref 440]');
  process.exit(1);
}
const options = Object.fromEntries(
  rest.map((a, i) => (a.startsWith('--') ? [a.slice(2), rest[i + 1]] : null)).filter(Boolean)
);
const reference = Number(options.ref || 440);
const string = STRINGS.find((s) => s.id === options.string);
const target = string && string.midi !== null
  ? reference * Math.pow(2, (string.midi - 69) / 12)
  : null;

const { samples, sampleRate } = readWav(file);
console.log(`${path.basename(file)} — ${(samples.length / sampleRate).toFixed(1)} s at ${sampleRate} Hz` +
  (target ? `, target ${options.string.toUpperCase()} = ${target.toFixed(2)} Hz` : ', auto note'));

const tails = [];
let reported = null;
for (const mode of MODES) {
  const readings = run(mode.id, samples, sampleRate, target);
  const grouped = notes(readings);
  if (!grouped.length) { console.log(`\n  ${mode.label}: no note detected`); continue; }

  console.log(`\n  ${mode.label}`);
  grouped.forEach((note, index) => {
    const live = note.entries.filter((e) => e.reading.status === 'live' && e.reading.frequency);
    if (!live.length) { console.log(`    pluck ${index + 1}: nothing reported`); return; }
    const noteHz = target || (() => {
      const last = live[live.length - 1].reading.frequency;
      return reference * Math.pow(2, Math.round(12 * Math.log2(last / reference)) / 12);
    })();
    const at = (t) => {
      const hit = live.filter((e) => e.frame.onsetAge <= t);
      return hit.length ? cents(hit[hit.length - 1].reading.frequency, noteHz).toFixed(1).padStart(6) : '     —';
    };
    const last = live[live.length - 1];
    // How jumpy the reading is late in the note — the "frenetic at the end" test.
    let worstJump = 0;
    for (let i = 1; i < live.length; i++) {
      if (live[i].frame.onsetAge < 1) continue;
      worstJump = Math.max(worstJump, Math.abs(cents(live[i].reading.frequency, live[i - 1].reading.frequency)));
    }
    console.log(
      `    pluck ${index + 1}: ${at(0.5)} ${at(1)} ${at(2)} ${at(3)} cents @0.5/1/2/3s · ` +
      `tracked ${last.frame.onsetAge.toFixed(1)}s · worst late jump ${worstJump.toFixed(1)}c` +
      (last.fit ? ` · glide +${last.fit.amplitude.toFixed(1)}c` : '')
    );
    if (mode.id === 'studio' && index === 0) {
      reported = { note, noteHz, mode: mode.label };
    }
    // The tail of a note is its settled pitch: the glide scales with amplitude
    // squared, so by the time the string is at a few percent of its peak the
    // excess is far under a cent. Measured from the quiet end with no
    // real-time constraint, this is ground truth for the whole recording.
    if (mode.id === 'strobe') {
      const tail = live.filter((e) => e.frame.onsetAge > last.frame.onsetAge * 0.7);
      if (tail.length >= 5) {
        const sorted = tail.map((e) => e.reading.frequency).sort((a, b) => a - b);
        tails.push({ index: index + 1, hz: sorted[sorted.length >> 1], samples: tail.length });
      }
    }
  });
}

if (tails.length) {
  console.log('\n  Settled pitch measured from each note\'s quiet tail');
  const nominal = target || reference * Math.pow(2, Math.round(12 * Math.log2(tails[0].hz / reference)) / 12);
  const midi = Math.round(12 * Math.log2(nominal / reference)) + 69;
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  console.log(`    nominal ${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1} = ${nominal.toFixed(3)} Hz at A4 = ${reference}`);
  for (const tail of tails) {
    const off = cents(tail.hz, nominal);
    console.log(`    pluck ${tail.index}: ${tail.hz.toFixed(3)} Hz  ${off >= 0 ? '+' : ''}${off.toFixed(2)} cents`);
  }
  if (tails.length > 1) {
    const offsets = tails.map((t) => cents(t.hz, nominal));
    console.log(`    spread across plucks: ${(Math.max(...offsets) - Math.min(...offsets)).toFixed(2)} cents`);
  }
}

if (reported) {
  const points = reported.note.entries.map(({ frame, reading }) => ({
    t: frame.onsetAge, abs: frame.time, raw: frame.f0, clarity: frame.clarity,
    rms: frame.rms, reported: reading.frequency, status: reading.status,
  }));
  const rawFit = reported.note.entries[reported.note.entries.length - 1].fit;
  const fit = rawFit ? { ...rawFit, originT: rawFit.origin - points[0].abs + points[0].t } : null;
  const { svg } = renderTrace({ points, noteHz: reported.noteHz, fit });
  const out = file.replace(/\.wav$/i, '') + '-trace.html';
  fs.writeFileSync(out, `<!DOCTYPE html><meta charset="utf-8"><body style="margin:0;background:#0b0d10">` +
    `<svg viewBox="0 0 360 262" width="720" xmlns="http://www.w3.org/2000/svg" font-family="system-ui">${svg}</svg></body>`);
  console.log(`\n  trace written to ${path.basename(out)} (${reported.mode}, first pluck)`);
}
