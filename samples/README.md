# Recordings

Real recordings are what the tuning modes get validated against. Everything in
here is replayed with:

```sh
node tools/analyse-wav.mjs samples/e2-1-reference.wav --string e2
```

which prints every mode's reading over time, how long it tracked the string, the
worst frame-to-frame jump late in the note, the glide it measured, and the
settled pitch taken from the note's quiet tail. It also writes
`<name>-trace.html` — the same chart the app shows.

## How to record

Record with the app: **Trace → Record 15 s → play**. The button counts down and
the file downloads itself when the fifteen seconds are up, so nothing has to be
timed by hand. Tapping it again mid-recording cancels. It captures raw
microphone audio, before any filtering, so a replay can also try filter choices
other than the app's. Half a second before the tap is included, in case the tap
came a moment late.

The panel keeps updating while you play, so leave it open for the whole session:
tap, play, wait for the download, repeat.

Set the **String** selector to the string you are recording — it goes into the
filename.

Rules that make the set usable:

- **Do not touch that string's tuning peg** until all of its recordings are
  done. One ground-truth measurement then applies to the whole set.
- **Mute the other five strings** (rest a finger or a cloth across them) for
  recordings 1–5, so each file contains one string only.
- **Leave two seconds of silence before each pluck** — the tuner needs to see
  the noise floor to know what silence sounds like.
- **Keep the phone in one place** for the whole session, wherever you would
  actually put it while tuning.
- **Tap Record first, then play.** The recording always runs a fixed 15 seconds.

## What to record, per string

| # | File | What to play |
| --- | --- | --- |
| 1 | `<string>-1-reference.wav` | The *softest* pluck that still rings clearly, right after the tap. Let it ring for the whole 15 s — don't stop it. **This is the ground truth**: the tail of a quiet note is the settled pitch to a fraction of a cent. |
| 2 | `<string>-2-normal.wav` | A normal pluck, the way you would play while tuning. Let it ring out. |
| 3 | `<string>-3-hard.wav` | The hardest pluck you would realistically use. Maximum pitch glide — the case that misleads a tuner most. |
| 4 | `<string>-4-replucks.wav` | Normal plucks about 1.5 s apart for the whole 15 s, never letting the string go quiet. A re-pluck beats against the note still ringing, which is where a wrong-turn bug was already found. |
| 5 | `<string>-5-pegturn.wav` | Pluck normally, let it settle ~2 s, then **slowly turn the peg flat** by roughly a quarter tone over ~3 s while it rings. Re-pluck once and let it ring. Do this one **last** for the string, then re-tune it. |

## Two extra recordings for the session

| File | What to play |
| --- | --- |
| `room-tone.wav` | Tap record and play nothing at all. Characterises the noise floor and any hum. |
| `open-strum.wav` | All six strings strummed once, left to ring. Tests picking one string out of a chord. |

Six strings × 5, plus those two, is 32 files. Fewer is still useful — recording
1 for each string is the single most valuable one, since it is the ground truth
everything else is scored against.
