// Compares the tuning modes against synthetic plucks whose true settled pitch
// is known exactly. Run: node tools/simulate-guitar.mjs
import { Engine } from '../engine.js';
import { createEstimator, MODES } from '../estimators.js';

const SR = 48000;
const cents = (a, b) => 1200 * Math.log2(a / b);

/**
 * Additive model of a plucked steel string:
 *  - partials stretched by inharmonicity B
 *  - higher partials decaying faster than the fundamental
 *  - pitch riding the square of the amplitude envelope (tension modulation),
 *    which is why a pluck reads sharp and drifts down over seconds
 *  - an unplugged solid body radiates almost nothing at the fundamental, and a
 *    phone mic rolls off below ~120 Hz on top of that
 */
const LEAD_IN = 0.4;   // silence before the pluck, as in real use

function pluck({ f0, seconds, glideCents = 15, tau = 2.2, B = 8e-5, level = 0.25, noise = 2e-4, micHighpass = 120, weakFundamental = true }) {
  const lead = Math.round(SR * LEAD_IN);
  const n = Math.round(SR * seconds) + lead;
  const out = new Float32Array(n);
  const partials = [];
  for (let m = 1; m <= 16; m++) {
    if (f0 * m > 6000) break;
    let amplitude = Math.pow(m, -1.15);
    if (weakFundamental && m <= 2) amplitude *= m === 1 ? 0.18 : 0.55;
    partials.push({ m, amplitude, tau: tau / Math.pow(m, 0.6), ratio: Math.sqrt((1 + B * m * m) / (1 + B)) });
  }
  const kappa = Math.pow(2, glideCents / 1200) - 1;

  let phase = 0;
  let hpState = 0;
  let hpPrev = 0;
  const hpCoefficient = Math.exp((-2 * Math.PI * micHighpass) / SR);

  for (let i = 0; i < n; i++) {
    const t = (i - lead) / SR;
    if (t < 0) { out[i] = noise * (Math.random() * 2 - 1); continue; }
    const envelope = Math.exp(-t / tau);
    const frequency = f0 * (1 + kappa * envelope * envelope);
    phase += (2 * Math.PI * frequency) / SR;

    let sample = 0;
    for (const p of partials) {
      sample += p.amplitude * Math.exp(-t / p.tau) * Math.sin(phase * p.m * p.ratio + p.m);
    }
    sample *= level;

    // one-pole high-pass standing in for the microphone
    const filtered = hpCoefficient * (hpState + sample - hpPrev);
    hpPrev = sample;
    hpState = filtered;

    out[i] = filtered + noise * (Math.random() * 2 - 1);
  }
  return out;
}

function run(modeId, signal, targetHz) {
  const engine = new Engine(SR);
  const estimator = createEstimator(modeId, {
    sampleRate: SR,
    engine,
    targetHz: () => targetHz,
  });

  const readings = [];
  const tickSamples = Math.round(SR * 0.04);
  let nextTick = tickSamples;
  for (let offset = 0; offset < signal.length; offset += 1024) {
    engine.push(signal.subarray(offset, Math.min(offset + 1024, signal.length)));
    while (engine.written >= nextTick) {
      const frame = engine.analyse();
      const reading = estimator.update(frame);
      readings.push({ time: frame.time, ...reading });
      nextTick += tickSamples;
    }
  }
  return readings;
}

function summarise(label, readings, trueHz) {
  const at = (seconds) => {
    const t = seconds + LEAD_IN;
    const hit = readings.filter((r) => r.time <= t && r.frequency > 0 && r.status !== 'idle');
    const last = hit[hit.length - 1];
    return last && last.status !== 'held' ? cents(last.frequency, trueHz) : NaN;
  };
  const live = readings.filter((r) => r.frequency > 0 && (r.status === 'live'));
  const lastLive = live[live.length - 1];
  const firstLive = live[0];
  const format = (v) => (Number.isNaN(v) ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(1).padStart(5));
  console.log(
    `  ${label.padEnd(16)} ${format(at(0.35))} ${format(at(0.8))} ${format(at(1.5))} ${format(at(3))} ` +
    `${format(at(5))}   first@${firstLive ? (firstLive.time - LEAD_IN).toFixed(2) : ' — '}s  last@${lastLive ? (lastLive.time - LEAD_IN).toFixed(1) : ' — '}s`
  );
}

/** A note that is already ringing while the peg is turned: the reading must follow. */
function pegTurn({ f0, seconds = 6, driftCents = 45, tau = 2.6, B = 9e-5 }) {
  const lead = Math.round(SR * LEAD_IN);
  const n = Math.round(SR * seconds) + lead;
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - lead) / SR;
    if (t < 0) { out[i] = 2e-4 * (Math.random() * 2 - 1); continue; }
    // peg turns steadily between 1.5 s and 4.5 s
    const progress = Math.max(0, Math.min(1, (t - 1.5) / 3));
    const frequency = f0 * Math.pow(2, (driftCents * progress) / 1200);
    phase += (2 * Math.PI * frequency) / SR;
    let sample = 0;
    for (let m = 1; m <= 12; m++) {
      const ratio = Math.sqrt((1 + B * m * m) / (1 + B));
      const amplitude = Math.pow(m, -1.15) * (m === 1 ? 0.18 : m === 2 ? 0.55 : 1);
      sample += amplitude * Math.exp(-t / (tau / Math.pow(m, 0.6))) * Math.sin(phase * m * ratio + m);
    }
    out[i] = 0.25 * sample + 2e-4 * (Math.random() * 2 - 1);
  }
  return out;
}

const CASES = [
  { name: 'Low E2 · hard pluck (unplugged electric)', f0: 82.41, glideCents: 18, tau: 2.4, B: 1.2e-4 },
  { name: 'Low E2 · soft pluck', f0: 82.41, glideCents: 5, tau: 2.8, B: 1.2e-4, level: 0.09 },
  { name: 'A2 · normal pluck', f0: 110, glideCents: 12, tau: 2.6, B: 9e-5 },
  { name: 'D3 · normal pluck', f0: 146.83, glideCents: 10, tau: 2.4, B: 7e-5 },
  { name: 'G3 · normal pluck', f0: 196, glideCents: 9, tau: 2.2, B: 6e-5 },
  { name: 'B3 · normal pluck', f0: 246.94, glideCents: 8, tau: 2.0, B: 1.5e-4 },
  { name: 'E4 · normal pluck', f0: 329.63, glideCents: 7, tau: 1.8, B: 1.8e-4 },
  { name: 'Low E2 · 30 cents flat', f0: 82.41 * Math.pow(2, -30 / 1200), glideCents: 15, tau: 2.4, B: 1.2e-4 },
];

console.log('Error in cents against the true settled pitch (blank = nothing shown).\n');
console.log(`  ${'mode'.padEnd(16)} ${'0.35s'.padStart(6)} ${'0.8s'.padStart(6)} ${'1.5s'.padStart(6)} ${'3s'.padStart(6)} ${'5s'.padStart(6)}`);

for (const testCase of CASES) {
  const signal = pluck({ seconds: 6, ...testCase });
  console.log(`\n${testCase.name}  (true ${testCase.f0.toFixed(2)} Hz, pluck +${testCase.glideCents}c)`);
  for (const mode of MODES) {
    summarise(mode.label, run(mode.id, signal, null), testCase.f0);
  }
}

// Turning the peg mid-note: the reading has to track the string up, not sit on
// a stale settled value. Errors here are against the pitch at that moment.
console.log('\n\nPeg turn on a ringing A2: +45 cents between 1.5 s and 4.5 s');
console.log('Error against the string\'s pitch at that instant.\n');
const drift = pegTurn({ f0: 110 });
for (const mode of MODES) {
  const readings = run(mode.id, drift, null);
  const truth = (t) => 110 * Math.pow(2, (45 * Math.max(0, Math.min(1, (t - 1.5) / 3))) / 1200);
  const at = (t) => {
    const hit = readings.filter((r) => r.time <= t + LEAD_IN && r.frequency > 0 && r.status === 'live');
    const last = hit[hit.length - 1];
    return last ? cents(last.frequency, truth(t)) : NaN;
  };
  const format = (v) => (Number.isNaN(v) ? '   —  ' : (v >= 0 ? '+' : '') + v.toFixed(1).padStart(5));
  console.log(`  ${mode.label.padEnd(16)} ${format(at(1.4))} ${format(at(2.5))} ${format(at(4))} ${format(at(5))}`);
}
