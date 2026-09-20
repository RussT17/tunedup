# TODO

Working list. Newest thinking at the top of each section; strike items when done
rather than deleting them, so the reasoning stays visible.

## Accuracy — open findings from the real samples

- [ ] **Low E, hard pluck: every mode reads ~+8 to +9 cents at 2 s.** All five
      agree, so the string really is still gliding — the extrapolation is
      under-correcting on a heavy wound string with a long decay. Probably the
      decay grid (`DECAY_CANDIDATES`, max 2.6 s) is too short for a low E, whose
      glide θ can be several seconds.
- [ ] **Studio sometimes over-corrects** — `a2-3-hard` reads −6.6 where Strobe
      alone gets −0.2. The trust blend lets the fit run too far on some notes.
- [ ] **B string: Strobe and the MPM modes disagree by ~3 cents**, consistently
      and in one direction. B3 is plain steel with high inharmonicity, so the
      suspect is the partial correction, the B estimate, or both.
- [ ] **Adaptive analysis window.** The window is a fixed 8192 samples (~170 ms)
      for every note. That is ~14 periods of a low E and ~57 of a high E — the
      low strings are the ones short of evidence and the high strings are paying
      for resolution they do not need. Scale the window with the detected or
      target frequency: more periods low, faster response high.
- [ ] **Envelope compensation inside the window.** A note decays *during* the
      170 ms being analysed, so the autocorrelation compares loud early samples
      against quieter later ones and is biased by it. Dividing out the measured
      envelope before correlating removes a bias that is largest on exactly the
      case that is worst today — a hard pluck on a fast-decaying string.
- [ ] **Octave errors as a named failure class.** The A2 rumble bug was one, and
      it read as a confident wrong answer rather than a visible failure. Defences
      so far: the room profile, the target lock, and MPM's first-peak rule. Worth
      adding a continuity check — a ringing string does not change octave
      mid-note, so a reading that jumps one is wrong by construction.
- [x] ~~Decide what to do about the first second after a pluck.~~ The note is
      named at about 200 ms, the number is shown but dimmed, the dial fills as
      the reading firms up, and "In tune" is withheld until it has filled. Every mode is
      several cents sharp there because the string is; "settling" is honest but
      the user still wants a number.

## Generality — not fitting one guitar in one room

- [ ] **Room profile, remaining pieces.** Learned passively and used to gate the
      spectrum (done). Still to do: (a) use it in the strobe's partial choice —
      prefer a partial that clears the room in its own band, which is the case a
      filter cannot help with, such as mains hum sitting on a partial;
      (b) subtract noise *power* when estimating amplitudes for the decay fit,
      which is the one statistically sound subtraction here; (c) notch
      narrowband interferers; (d) tell the user when a room is too noisy to tune
      in; (e) show the learned profile in the Trace panel; (f) an explicit
      "calibrate" control for forcing a re-learn.
- [ ] **Replace magic constants with measured quantities.** Every threshold
      chosen by looking at data is a chance to overfit. The gate ratios, the
      attack skip, the fade gate, the slew limit and the unwrap tolerance should
      each be derived from the noise floor, the sample rate, or the physics,
      or be justified in a comment as to why a constant is right.
- [x] ~~Randomised synthetic sweep as a regression gate~~ — `tools/sweep.mjs`,
      40 randomised plucks per run, and `tools/score.mjs` scores the real
      samples and the sweep together against a saved baseline.
- [ ] **A second dataset**: another instrument, another room, another phone.
      One guitar is one guitar.
- [ ] **Instrument selection** (guitar, bass, cello, piano) to narrow the search
      range and the expected inharmonicity. No longer needed for *range* — the
      room profile replaced the fixed cutoff — but still useful as a prior.

## Features discussed, not yet built

- [ ] **Instrument profile / per-string calibration.** Record each open string
      once; store the partial-amplitude signature, inharmonicity B, decay τ and
      the player's own glide coefficient. Then: auto-detect *which* string is
      being played from timbre (no dropdown), and correct the attack sharpness
      on the first frame instead of fitting it each time.
- [ ] **Joint harmonic fit as a mode** — solve f0 and B together across all
      partials rather than tracking one. Better when several partials are strong.
- [ ] **Sweetened and alternate tunings** (guitarists often want the G string a
      couple of cents off equal temperament; drop D; open tunings).

## App and housekeeping

- [ ] **Pick a default mode and retire the dropdown** once the data says which
      one wins. It is a testing affordance, not a feature.
- [ ] **Show the room noise profile in the Trace panel**, so what the app has
      learned is visible and checkable.
- [ ] **Service worker update prompt** — new versions currently need a reload.
- [ ] `samples/` is 46 MB in git history. Fine for now; revisit if it grows.

## Known limitations

- All validation is against one guitar, one room, one phone, plus a simulator.
- Ground truth from `tools/measure-truth.mjs` carries a known bias of about
  +0.65 cents, measured against synthetic notes: the analysis window still
  contains a little residual pitch glide. Treat truth as ±1 cent.
- The truth tool and the strobe estimator agree within 0.6 cents on four
  strings but differ by 3.4 cents on A2, and D3 measured unstably. Those two
  are also the two with the shortest tracking. Unresolved.

## Done

- [x] **Hard plucks: stopped fitting, started coaching.** The measurements are
      unambiguous. A hard low E really does settle at the same pitch as a soft
      one — independent measurement converges to −11.6 cents against the soft
      take's −11.2 — but it takes over three seconds to get there, against
      under one for a normal pluck. Three attempts to model that failed:
      a longer decay grid let the fit claim a 51-cent glide and overshoot by
      16; deriving the decay time from the measured envelope, which is right in
      principle since the glide follows the square of the amplitude, returned a
      value three times too fast because a plucked string's envelope is
      two-stage — 14 dB in the first 1.5 s as the high partials die, then 17 dB
      over the next four — and every way of fitting it scored worse. Each
      attempt also degraded the cases that already worked.
      So: the app measures each pluck's glide anyway, and now says
      "plucked hard — softer settles sooner" when it exceeds 15 cents. A normal
      pluck reads inside half a cent; that is the supported case, stated plainly
      rather than approximated badly.

- [x] Output smoothing on the fitted modes. The fit re-solves every tick and
      each solve moved the number by cents; shown raw it fidgeted. Worst
      frame-to-frame jump on the real samples: Studio 4.6 → 1.7 cents,
      Predict 14.8 → 4.4, at no cost in accuracy.
- [x] Ground truth is now a characterised instrument: median of several windows
      that each sit wholly inside the note, ±1 cent, with a known bias of about
      +0.85 cents that applies equally to every string — so mode *comparisons*,
      which is what it is for, are unaffected. A cleverer version that fitted
      and extrapolated the glide was excellent on soft plucks and 20 cents out
      on hard ones, and was thrown away: a ruler that is sometimes brilliant is
      not a ruler.

- [x] Room profile replaces the fixed high-pass: each band is judged against
      what that band normally does, so a low note is admitted exactly where a
      steady rumble is dropped. The 70 Hz cutoff is gone and the full range is
      back. On the real samples the bands of a plucked string jump 30 dB while
      the room's rumble band moves 5.
- [x] Independent ground truth (`tools/measure-truth.mjs`), sharing no code
      with the estimators, validated against synthetic notes to 0.7 cents.

- [x] Room rumble at 58 Hz was making soft low strings unreadable; steep
      high-pass at 70 Hz and a target-driven search range.
- [x] Notes ended on level alone, cutting soft strings off early.
- [x] Phase unwrapper took a wrong turn on a re-pluck over a ringing string,
      reading 18–32 cents off with full confidence.
- [x] Phase tracking went frenetic as a note died.
- [x] Inharmonicity was estimated relative to a fundamental that is often
      missing; now regressed across every detected partial.
- [x] Trace view, WAV recording on a countdown, and the replay tool.
