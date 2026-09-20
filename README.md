# TunedUp

A chromatic instrument tuner that runs in the browser — no install, no account, no
network after the first load. Open it, play a note, tune.

**Live app:** https://russt17.github.io/tunedup/

## What it does today

- Listens through the device microphone (tap once to grant access; after that it
  starts listening the moment you open it).
- Shows the nearest note, and how many cents flat or sharp you are, updating
  continuously while you turn the peg.
- Needle turns green and reads *In tune* within ±3 cents.
- Holds and dims the last reading when the note dies away, so you can look up
  after plucking.
- Reference pitch is adjustable from 415 to 466 Hz (default A4 = 440) and is
  remembered between visits.
- Installable as a PWA and fully usable offline.

## How the pitch detection works

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
signals with a missing fundamental. Real instruments — inharmonicity, room noise,
attack transients — are the work still ahead.

## Running it locally

It is a static site with no build step:

```sh
npx http-server -p 8080 .    # then open http://localhost:8080
```

Microphone access needs a secure context, so use `localhost` or https.

Check the detector against synthetic tones:

```sh
node tools/test-pitch.mjs
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
| `app.js` | Mic capture, smoothing, note maths, UI |
| `pitch.js` | MPM pitch detection (FFT autocorrelation) |
| `sw.js`, `manifest.webmanifest` | PWA shell and offline cache |
| `tools/` | Icon generator, detector test |
