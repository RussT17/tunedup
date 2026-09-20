# TunedUp

A chromatic instrument tuner that runs in the browser — no install, no account, no
network after the first load. Open it, play a note, tune.

**Live app:** https://russt17.github.io/tunedup/

## What it does today

- Listens through the device microphone (tap once to grant access; after that it
  starts listening the moment you open it).
- Shows the nearest note, and how many cents flat or sharp you are, updating
  continuously while you turn the peg.
- Needle turns green and reads *In tune* within ±3 cents. A reading the current
  mode does not yet trust is shown dimmed and never claims to be in tune.
- Holds and dims the last reading when the note dies away, so you can look up
  after plucking.
- Five selectable detection modes (below), a target-string lock for guitar, and
  a reference pitch from 415 to 466 Hz. All three are remembered between visits.
- Installable as a PWA and fully usable offline.

## Why a plucked string needs more than a pitch detector

A plucked string does not have one pitch. Displacing it raises the average
tension, tension raises the frequency, and the excess decays away with the
square of the amplitude envelope. So the note starts sharp and glides down —
by 5 to 20 cents on a hard pluck, over *seconds*, not milliseconds, because
that envelope is what a long-sustaining low string is made of.

Two things follow. Skipping the attack is not enough: at 250 ms a low E is
still most of the way sharp. And a tuner that averages the recent past reports
a moving target, which reads as "sharp, then less sharp, then the note dies
while still looking sharp" — on an unplugged electric the string can run out of
audible signal before the glide finishes.

The pitch worth tuning to is the zero-amplitude limit: what the string settles
to, which is also what a very soft pluck reads. `predict` and `studio`
estimate that limit directly rather than waiting for it, by fitting
`y(t) = settled + A·e^(-t/θ)` to the readings and reporting the intercept.

## Detection modes

| Mode | What it does |
| --- | --- |
| `standard` | v1: median of the last 220 ms. Kept as the baseline to compare against. |
| `sustain` | Skips the first 250 ms and gates against the noise floor rather than a fixed level, so it follows a decaying string much further down. |
| `predict` | Fits the decay curve to MPM readings and reports the settled pitch. |
| `strobe` | Locks onto the clearest partial and phase-tracks it against a fixed reference, the way a strobe tuner works. Narrowband, so it keeps hearing quiet low strings, and it corrects for string inharmonicity. |
| `studio` | Strobe lock feeding the settled-pitch fit. Most accurate in simulation; most moving parts. |

Against a simulated low E plucked hard (true pitch 14 cents flat, 18 cents of
glide), measured through the real app:

```
mode       @1.0s      @2.0s      @3.5s
standard   +7 cents   −4 cents   −11 cents
sustain    +7 cents   In tune    −11 cents
predict    +6 cents   −17 cents  −16 cents
strobe     In tune    −7 cents   −11 cents
studio     In tune    −14 cents  −14 cents      ← true answer, held from 2 s
```

`node tools/simulate-guitar.mjs` runs the full comparison across all six
strings, plus a peg-turn test that checks the reading still tracks a string
being tuned in real time.

## Target string lock

Selecting a string (rather than `Auto`) tells the tuner what you are aiming at.
It keeps the display on that note however far out of tune the string is, rejects
anything more than 300 cents away as noise or a neighbouring string, and gives
`strobe` its reference frequency without needing to identify the note first.

## How the underlying pitch detection works

`pitch.js` implements the McLeod Pitch Method (MPM). For each ~170 ms window of
audio it computes the normalised square difference function

```
n(τ) = 2·r(τ) / m(τ)
```

where `r(τ)` is the autocorrelation at lag τ and `m(τ)` is the summed power of the
two overlapping windows. The autocorrelation is computed with an FFT
(Wiener–Khinchin), which keeps a full analysis at about 1.5 ms of CPU per frame —
cheap enough to run 25 times a second on a phone.

The period is taken from the *first* NSDF peak that reaches 90% of the tallest
peak, which is what keeps the reading off the octave above or below, and the peak
is refined by parabolic interpolation for sub-cent resolution. Readings are
accepted only above a clarity threshold, and the displayed value is the median of
the readings from the last 220 ms.

On synthetic tones the error stays under half a cent from 41 Hz to 880 Hz, including
signals with a missing fundamental. That is the floor the modes above build on; the rest is
deciding which number a real, decaying, inharmonic string should report.

## Running it locally

It is a static site with no build step:

```sh
npx http-server -p 8080 .    # then open http://localhost:8080
```

Microphone access needs a secure context, so use `localhost` or https.

Check the detector against synthetic tones, and the modes against synthetic
guitar plucks:

```sh
node tools/test-pitch.mjs
node tools/simulate-guitar.mjs
```

Regenerate the app icons after changing `tools/make-icons.py`:

```sh
python3 tools/make-icons.py
```

## Deployment

Pushing to `main` publishes the site with the workflow in
`.github/workflows/deploy.yml`. It needs **Settings → Pages → Source → GitHub
Actions** enabled once on the repository.

Bump `CACHE` in `sw.js` when shipping changes so installed copies pick them up.

## Layout

| File | Purpose |
| --- | --- |
| `index.html` | Markup and the SVG meter |
| `styles.css` | All styling and the colour states |
| `app.js` | Mic capture, controls, note maths, UI |
| `engine.js` | Ring buffer, noise floor, onset detection, per-tick frames |
| `estimators.js` | The five detection modes and the string table |
| `capture-worklet.js` | AudioWorklet feeding contiguous audio to the engine |
| `pitch.js` | MPM pitch detection and spectrum helpers |
| `sw.js`, `manifest.webmanifest` | PWA shell and offline cache |
| `tools/` | Icon generator, detector test |
