// Independent ground truth for a recording of one sustained note.
//
// Deliberately shares nothing with the tuner's own estimators: it takes a long
// window from the quiet part of the note, where the pitch glide is spent, and
// fits the partial series directly. A stiff string puts partial m at
// m*f1*sqrt(1 + B*m^2), so 2*ln(f_m / m) is linear in m^2 — regressing that over
// every visible partial gives both the fundamental and the inharmonicity,
// without needing the fundamental to be audible at all.
//
//   node tools/measure-truth.mjs samples/e2-1-reference.wav 82.41
import fs from 'fs';
import path from 'path';
import { spectrum } from '../pitch.js';

const WINDOW = 1 << 18;          // ~5.5 s at 48 kHz
const cents = (a, b) => 1200 * Math.log2(a / b);

function readWav(file) {
  const b = fs.readFileSync(file);
  const sampleRate = b.readUInt32LE(24);
  const n = (b.length - 44) / 2;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { samples, sampleRate };
}

/** Start of the loudest sustained stretch, so the window sits on the note. */
function findNote(samples, sampleRate) {
  const hop = Math.round(sampleRate * 0.05);
  let best = 0, bestAt = 0;
  for (let at = 0; at + hop < samples.length; at += hop) {
    let sum = 0;
    for (let i = at; i < at + hop; i++) sum += samples[i] * samples[i];
    if (sum > best) { best = sum; bestAt = at; }
  }
  return bestAt;
}

export function measure(file, nominal) {
  const { samples, sampleRate } = readWav(file);
  // Skip the attack: start a second after the peak so the glide is spent.
  const start = Math.min(
    findNote(samples, sampleRate) + Math.round(sampleRate * 1.0),
    Math.max(0, samples.length - WINDOW)
  );
  const window = samples.subarray(start, start + WINDOW);
  const { magnitude, fftSize } = spectrum(window, Math.min(WINDOW, window.length));

  // Peak search and noise estimate are sized in Hz, not bins: this spectrum is
  // 32x finer than the tuner's, so a bin-count neighbourhood would sit inside
  // the peak's own skirt and report nonsense.
  const hzPerBin = sampleRate / fftSize;
  const partials = [];
  for (let m = 1; m <= 16; m++) {
    const centre = nominal * m;
    if (centre > sampleRate / 2.5) break;
    const span = Math.round((centre * 0.04) / hzPerBin);
    const at = Math.round(centre / hzPerBin);
    let peak = at;
    for (let i = at - span; i <= at + span; i++) {
      if (i > 1 && i < magnitude.length - 1 && magnitude[i] > magnitude[peak]) peak = i;
    }
    if (peak < 2 || peak > magnitude.length - 2) continue;

    const a = Math.log(magnitude[peak - 1] + 1e-15);
    const b2 = Math.log(magnitude[peak] + 1e-15);
    const c = Math.log(magnitude[peak + 1] + 1e-15);
    const curvature = a - 2 * b2 + c;
    const shift = curvature ? (0.5 * (a - c)) / curvature : 0;
    if (!(Math.abs(shift) <= 1)) continue;

    const skirt = Math.round(6 / hzPerBin);
    const reach = Math.round(40 / hzPerBin);
    const around = [];
    for (let i = peak - reach; i <= peak + reach; i++) {
      if (i > 1 && i < magnitude.length && Math.abs(i - peak) > skirt) around.push(magnitude[i]);
    }
    around.sort((x, y) => x - y);
    const floor = around.length ? around[around.length >> 1] : 1e-12;
    const snr = magnitude[peak] / (floor + 1e-15);
    if (snr < 6) continue;

    partials.push({ m, frequency: (peak + shift) * hzPerBin, snr });
  }
  if (!partials.length) return null;

  // Not every peak near m*nominal is that partial: sympathetic ringing from
  // other strings, room modes and plain noise all put peaks there, and on a
  // real recording they implied fundamentals 40 cents out. Inharmonicity gives
  // a physical test. A partial of THIS string satisfies
  // f_m = m*f1*sqrt((1 + B*m^2)/(1 + B)) for one small positive B; solving for
  // B per candidate and discarding anything outside the physical range throws
  // the impostors out and keeps the stretched-but-real high partials.
  const seedCandidates = partials.filter((p) => p.m <= 3).map((p) => p.frequency / p.m);
  if (seedCandidates.length) {
    seedCandidates.sort((a, b) => a - b);
    const seed = seedCandidates[seedCandidates.length >> 1];
    const kept = partials.filter((p) => {
      if (p.m === 1) return true;
      const ratio = p.frequency / (p.m * seed);
      const implied = (ratio * ratio - 1) / (p.m * p.m - 1);
      return implied > -8e-5 && implied < 1.5e-3;
    });
    partials.length = 0;
    partials.push(...kept);
  }
  if (!partials.length) return null;

  let B = 0;
  if (partials.length >= 4) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of partials) {
      const w = Math.log(1 + p.snr);
      const x = p.m * p.m;
      const y = 2 * Math.log(p.frequency / p.m);
      sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
    }
    const denom = sw * sxx - sx * sx;
    if (denom) B = Math.max(0, Math.min(2e-3, (sw * sxy - sx * sy) / denom));
  }

  let sw = 0, sy = 0;
  for (const p of partials) {
    const w = Math.log(1 + p.snr);
    sw += w;
    sy += w * Math.log(p.frequency / (p.m * Math.sqrt((1 + B * p.m * p.m) / (1 + B))));
  }
  const f1 = Math.exp(sy / sw);

  return { f1, B, partials, start: start / sampleRate };
}

if (process.argv[1] && process.argv[1].endsWith('measure-truth.mjs')) {
  const [file, nominalArg] = process.argv.slice(2);
  const nominal = Number(nominalArg);
  const result = measure(file, nominal);
  if (!result) { console.log('not enough partials'); process.exit(1); }
  console.log(`${path.basename(file)} — window from ${result.start.toFixed(1)}s`);
  console.log(`  partials used: ${result.partials.map((p) => p.m).join(', ')}` +
    (result.partials.length < 4 ? '  (too few for an inharmonicity fit — B assumed 0)' : ''));
  console.log(`  inharmonicity B = ${result.B.toExponential(2)}`);
  console.log(`  f1 = ${result.f1.toFixed(3)} Hz  (${cents(result.f1, nominal) >= 0 ? '+' : ''}${cents(result.f1, nominal).toFixed(2)} cents vs ${nominal})`);
}
