# Recordings

Drop real instrument recordings here — they are what the modes get tuned against.

Record them with the app itself: **Trace → Save recording (WAV)**. That captures
the last 15 seconds exactly as the tuner heard it, through the same microphone,
filters and sample rate, so a replay reproduces what happened on the phone.

Name them so the intent is obvious: `e2-hard-pluck.wav`, `a2-soft.wav`,
`g3-flat-then-tuned.wav`.

Replay one through every mode:

```sh
node tools/analyse-wav.mjs samples/e2-hard-pluck.wav --string e2
```

That prints each mode's reading at 0.5 / 1 / 2 / 3 seconds, how long it tracked
the string, the worst frame-to-frame jump late in the note (the "went frenetic"
check), and the glide it measured. It also writes `<name>-trace.html` next to the
recording — the same trace chart the app shows.
