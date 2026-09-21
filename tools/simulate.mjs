// A randomised synthetic guitar, with everything the real thing does that the
// estimator has to survive -- and with the pitch known exactly by construction,
// which is the whole point. DESIGN §13 calls this the overfitting alarm: a
// change that improves the 32 real recordings and worsens this has fitted one
// guitar in one room.
//
// It is deliberately WIDER than one instrument in one room: pluck strength,
// decay rates, inharmonicity, partial balance, microphone roll-off, noise
// colour and a room rumble at a random frequency all vary per take.

export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function synthNote(opts) {
  const {
    sampleRate = 48000,
    duration = 6,
    f1,
    B,
    // Tension-modulation glide: excess proportional to amplitude SQUARED, so
    // it decays at the POWER rate -- half the amplitude time constant (§2.1).
    glideCents = 8,
    ampTau = 2.2,
    highTau = 0.7,
    nPartials = 16,
    level = 0.2,
    noise = 0.002,
    rumbleHz = 0,
    rumbleLevel = 0,
    micHpHz = 0,
    seed = 1,
    startAt = 0.5,
  } = opts;

  // §2.1: the excess is proportional to displacement SQUARED, so it decays at
  // the signal's POWER rate -- half the time constant of its AMPLITUDE
  // envelope. Giving the glide its own independent time constant (an earlier
  // version of this file did) makes the identity d = theta * |dy/dt|
  // unlearnable and quietly turns the sweep into a test of something else.
  const theta = ampTau / 2;
  const rng = makeRng(seed);
  const n = Math.round(duration * sampleRate);
  const out = new Float32Array(n);
  const onset = Math.round(startAt * sampleRate);

  const phases = [];
  const amps = [];
  const taus = [];
  const beatHz = [];
  const beatDepth = [];
  for (let m = 1; m <= nPartials; m++) {
    phases.push(rng() * 2 * Math.PI);
    // A plucked string's partial balance, with the fundamental often weak on a
    // solid body radiating into a phone (§2.3).
    const tilt = m === 1 ? 0.25 + rng() * 0.5 : 1 / Math.pow(m, 0.9 + rng() * 0.6);
    amps.push(tilt * (0.7 + 0.6 * rng()));
    // High partials die first: measured 14 dB in 1.5 s then 17 dB over four.
    taus.push(1 / (1 / ampTau + (m - 1) / (nPartials * highTau)));
    // Polarisation beating: ordinary guitar behaviour, slow and shallow, and
    // NOT a fault the estimator may reject.
    beatHz.push(0.3 + rng() * 1.4);
    beatDepth.push(0.05 + rng() * 0.25);
  }

  for (let i = 0; i < n; i++) {
    const t = (i - onset) / sampleRate;
    let v = 0;
    if (t >= 0) {
      // Cents above settled, decaying at the power rate.
      const excess = glideCents * Math.exp(-t / theta);
      const ratio = Math.pow(2, excess / 1200);
      for (let k = 0; k < nPartials; k++) {
        const m = k + 1;
        const fm = m * f1 * Math.sqrt((1 + B * m * m) / (1 + B)) * ratio;
        if (fm > sampleRate * 0.45) continue;
        const env = Math.exp(-t / taus[k]) * (1 + beatDepth[k] * Math.sin(2 * Math.PI * beatHz[k] * t));
        // Integrate the instantaneous frequency so the glide is a real chirp.
        const phase = phases[k] + 2 * Math.PI * (
          m * f1 * Math.sqrt((1 + B * m * m) / (1 + B)) *
          (t + (glideCents * Math.LN2 / 1200) * theta * (1 - Math.exp(-t / theta)))
        );
        v += amps[k] * env * Math.sin(phase);
      }
      v *= level;
    }
    if (rumbleLevel > 0) {
      v += rumbleLevel * Math.sin(2 * Math.PI * rumbleHz * i / sampleRate + 0.7)
         + rumbleLevel * 0.4 * Math.sin(2 * Math.PI * rumbleHz * 2 * i / sampleRate + 2.1);
    }
    v += noise * (rng() * 2 - 1);
    out[i] = v;
  }

  if (micHpHz > 0) {
    const w = Math.tan(Math.PI * micHpHz / sampleRate);
    const q = Math.SQRT1_2;
    const nn = 1 / (1 + w / q + w * w);
    const b0 = nn, b1 = -2 * nn, b2 = nn, a1 = 2 * (w * w - 1) * nn, a2 = (1 - w / q + w * w) * nn;
    let z1 = 0, z2 = 0;
    for (let i = 0; i < n; i++) {
      const x = out[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      out[i] = y;
    }
  }
  return out;
}

// One random take. The ranges are wider than the guitar the recordings came
// from, on purpose.
export function randomTake(seed) {
  const rng = makeRng(seed * 2654435761);
  const midi = 40 + Math.floor(rng() * 25);          // E2 .. E4
  const detune = (rng() * 2 - 1) * 45;               // cents from equal temperament
  const f1 = 440 * Math.pow(2, (midi - 69) / 12) * Math.pow(2, detune / 1200);
  const plain = f1 > 180;
  return {
    f1,
    B: plain ? 4e-5 + rng() * 2.2e-4 : 1.5e-5 + rng() * 6e-5,
    glideCents: 2 + rng() * 22,
    ampTau: 1.2 + rng() * 3,
    highTau: 0.35 + rng() * 0.9,
    level: 0.05 + rng() * 0.35,
    noise: 0.0004 + rng() * 0.004,
    rumbleHz: 35 + rng() * 60,
    rumbleLevel: rng() < 0.6 ? 0.002 + rng() * 0.02 : 0,
    micHpHz: rng() < 0.5 ? 30 + rng() * 60 : 0,
    nPartials: 10 + Math.floor(rng() * 8),
    seed: seed * 7919 + 13,
  };
}
