# TunedUp

A guitar tuner that runs in a browser and tells you how sure it is.

**[Open it](https://russt17.github.io/tunedup/)** — hold the button for two
seconds while the room is quiet, then play a string.

Holding the button *is* the room measurement. There is no separate calibration
step, and the two seconds you wait are two seconds the tuner spends learning
what your room sounds like so it can ignore it. The same control stays
available while you tune, because rooms change — someone starts a dryer.

---

## What is unusual about it

**It knows how sure it is, and acts on it.** Every reading carries a σ in
cents. The tuner shows a number only when σ is small enough to mean something,
and it says *in tune* only when `|cents| + 2σ ≤ 3` — an interval, not a
threshold on the point estimate. A tuner that occasionally says nothing is
usable; a tuner that occasionally lies is not.

**It corrects the pluck glide instead of waiting it out.** Displacing a string
raises its tension, so a pluck starts sharp and slides down: +5 cents for a
soft pluck, +18 to +25 for a hard one. Most tuners let you wait. This one
measures the decay rate and the pitch slope and subtracts what is left, because
the two are related exactly for an exponential glide. If it cannot measure them
it says so in σ rather than quietly showing you a sharp number.

**It does not need to hear the fundamental.** On an unplugged electric the
first partial can sit 20 dB below the third. TunedUp fits the string's
frequency *and* its stiffness from whichever partials it can see, which is why
it works on the strings that are hardest to tune.

**When it won't show a number, it tells you why.** "Too much background noise
to tune here" is a better answer than a confident wrong one.

## How well it works

| | measured |
|---|---|
| settled accuracy, synthetic (pitch exact by construction) | median **0.20 cents**, p90 1.02 |
| settled accuracy, 32 real recordings | median **0.90 cents**, p90 3.2 |
| false "in tune" beyond 3 cents | **0 of 337** claims |
| time to a usable reading | median 520 ms, p90 860 ms |
| tracking duration after one pluck | 0.9–2.8 s |
| stitched sessions: wrong strings, readings in silence, jumps | **0, 0, 0** in 3587 readings |

Where it is weakest: a softly plucked low E goes quiet to the tuner after about
a second, against a 4-second goal. See [DESIGN.md §12](DESIGN.md).

## Running the checks

Nothing ships without all four harnesses. `npm run check` runs the first three.

```
npm run score     # 32 real recordings against independent ground truth
npm run sweep     # randomised synthetic guitar: absolute accuracy, sigma calibration
npm run session   # recordings stitched into whole sessions: glitches, not accuracy
npm run browser   # the real app in a real browser with faked audio
```

Each answers a different question and they are not interchangeable. The real
recordings answer *did that change make it better?* The sweep is the only one
that can answer *is σ honest?*, because its pitch is exact while the
recordings' ground truth is only ±1 cent — testing a sub-cent σ against a
±1 cent reference measures mostly the reference. The stitched sessions grade
glitchiness, and every failure ever reported from real use showed up there and
nowhere else. The browser test measures the plumbing, which is the actual risk.

## Layout

```
index.html  app.js  styles.css    the UI
src/capture-worklet.js            copies audio, and nothing else
src/worker.js                     a shell around the engine
src/dsp/                          all of the signal processing, no DOM
  engine.js     the pipeline, assembled
  room.js       per-bin noise floor: minimum statistics + the held button
  acquire.js    which note is this? (gated NSDF)
  partials.js   exactly what frequency? (per-partial heterodyne)
  fit.js        f1 and stiffness together, from whatever partials survive
  glide.js      how much of the pluck's sharpness is left
  settle.js     combining successive readings without lagging a peg turn
  gates.js      the eight named ways a reading can be invalid
tools/                            the harnesses above
samples/                          32 recordings + measured ground truth
DESIGN.md                         why the pipeline is shaped this way
```

`src/dsp` has no `AudioContext` and no DOM in it. That is the only reason any
of it can be measured offline.

## Credits

Built with [Claude Code](https://claude.com/claude-code).
