// The overfitting alarm.
//
// Scores every mode against randomised plucks whose true pitch is known by
// construction, with the conditions varied far wider than one guitar in one
// room: string frequency across the whole instrument range, pluck strength,
// decay time, inharmonicity, microphone roll-off, noise level, and a room
// rumble at a random frequency and level. A change that improves the real
// samples and worsens this is a change that fitted one guitar.
//
//   node tools/sweep.mjs [count] [seed]
import { Engine } from '../engine.js';
import { createEstimator, MODES } from '../estimators.js';

const SR = 48000;
const cents = (a, b) => 1200 * Math.log2(a / b);

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function scenario(random) {
  const pick = (lo, hi) => lo + random() * (hi - lo);
  return {
    f0: pick(38, 400),                  // low bass B up to well above a guitar's top string
    glide: pick(1, 28),                 // cents sharp at the attack
    tau: pick(0.7, 4),                  // amplitude decay
    B: Math.pow(10, pick(-5.2, -3.2)),  // inharmonicity, wound through plain steel
    level: Math.pow(10, pick(-1.6, -0.5)),
    noise: Math.pow(10, pick(-4.2, -2.8)),
    rumbleHz: pick(35, 95),
    rumbleLevel: Math.pow(10, pick(-4, -2.2)),
    micHighpass: pick(50, 220),         // phones vary enormously down low
    weakFundamental: random() < 0.6,
    lead: pick(0.5, 1.5),
  };
}

function render(s, seconds = 7) {
  const lead = Math.round(s.lead * SR);
  const n = Math.round(seconds * SR) + lead;
  const out = new Float32Array(n);
  const partials = [];
  for (let m = 1; m <= 18; m++) {
    if (s.f0 * m > 7000) break;
    let amplitude = Math.pow(m, -1.15);
    if (s.weakFundamental && m <= 2) amplitude *= m === 1 ? 0.18 : 0.55;
    partials.push({ m, amplitude, tau: s.tau / Math.pow(m, 0.6), ratio: Math.sqrt((1 + s.B * m * m) / (1 + s.B)) });
  }
  const kappa = Math.pow(2, s.glide / 1200) - 1;

  let phase = 0;
  let rumblePhase = 0;
  let hp = 0;
  let prev = 0;
  const coefficient = Math.exp((-2 * Math.PI * s.micHighpass) / SR);

  for (let i = 0; i < n; i++) {
    const t = (i - lead) / SR;
    rumblePhase += (2 * Math.PI * s.rumbleHz) / SR;
    let sample = s.rumbleLevel * (Math.sin(rumblePhase) + 0.4 * Math.sin(rumblePhase * 1.7 + 1));
    if (t >= 0) {
      const envelope = Math.exp(-t / s.tau);
      phase += (2 * Math.PI * s.f0 * (1 + kappa * envelope * envelope)) / SR;
      let note = 0;
      for (const p of partials) {
        note += p.amplitude * Math.exp(-t / p.tau) * Math.sin(phase * p.m * p.ratio + p.m);
      }
      sample += s.level * note;
    }
    const filtered = coefficient * (hp + sample - prev);
    prev = sample;
    hp = filtered;
    out[i] = filtered + s.noise * (Math.random() * 2 - 1);
  }
  return out;
}

function run(modeId, signal, target) {
  const engine = new Engine(SR);
  engine.setTarget(target);
  const estimator = createEstimator(modeId, { sampleRate: SR, engine, targetHz: () => target });
  const tick = Math.round(SR * 0.04);
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

const count = Number(process.argv[2] || 40);
const seed = Number(process.argv[3] || 20260920);
const random = makeRandom(seed);

const stats = new Map(MODES.map((m) => [m.id, { at1: [], at2: [], at3: [], held: [], jump: [], lost: 0, wrongNote: 0 }]));

for (let i = 0; i < count; i++) {
  const s = scenario(random);
  const signal = render(s);
  for (const mode of MODES) {
    const readings = run(mode.id, signal, null);
    const live = readings.filter((e) => e.reading.status === 'live' && e.reading.frequency && e.frame.onsetAge !== null);
    const stat = stats.get(mode.id);
    if (!live.length) { stat.lost++; continue; }
    const at = (t) => {
      const hit = live.filter((e) => e.frame.onsetAge <= t);
      return hit.length ? cents(hit[hit.length - 1].reading.frequency, s.f0) : null;
    };
    // An octave error is a different kind of wrong: count it, do not average it.
    const final = at(3) ?? at(2) ?? at(1);
    if (final !== null && Math.abs(final) > 300) { stat.wrongNote++; continue; }
    for (const [key, value] of [['at1', at(1)], ['at2', at(2)], ['at3', at(3)]]) {
      if (value !== null && Math.abs(value) <= 300) stat[key].push(Math.abs(value));
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

const quantile = (values, q) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const show = (v) => (Number.isNaN(v) ? '   — ' : v.toFixed(1).padStart(5));

console.log(`Randomised sweep: ${count} plucks, seed ${seed}\n`);
console.log('  mode        |err| @1s        @2s        @3s     tracked  worst    octave');
console.log('              med   p90   med   p90   med   p90     med    jump    errors  lost');
for (const mode of MODES) {
  const s = stats.get(mode.id);
  console.log(
    `  ${mode.label.padEnd(10)} ${show(quantile(s.at1, 0.5))} ${show(quantile(s.at1, 0.9))} ` +
    `${show(quantile(s.at2, 0.5))} ${show(quantile(s.at2, 0.9))} ` +
    `${show(quantile(s.at3, 0.5))} ${show(quantile(s.at3, 0.9))} ` +
    `${show(quantile(s.held, 0.5))}s ${show(quantile(s.jump, 0.9))}c ` +
    `${String(s.wrongNote).padStart(7)} ${String(s.lost).padStart(5)}`
  );
}
console.log('\n  cents of error against the true settled pitch; p90 is the bad-case tail.');
