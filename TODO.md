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
- [ ] Decide what to do about the first second after a pluck. Every mode is
      several cents sharp there because the string is; "settling" is honest but
      the user still wants a number.

## Generality — not fitting one guitar in one room

- [ ] **Room noise profile.** Learn the spectrum of the room, not just a
      broadband level: passively, from the gaps between notes, with an explicit
      "calibrate" affordance as a fallback. Use it to (a) place the high-pass
      just above the room's low-frequency noise rather than at a fixed 70 Hz,
      bounded so it can never climb above the string being tuned, (b) require a
      partial to clear the room's level *in its own band* before being trusted,
      (c) notch narrowband interferers such as mains hum, (d) tell the user when
      a room is too noisy to tune in.
- [ ] **Replace magic constants with measured quantities.** Every threshold
      chosen by looking at data is a chance to overfit. The gate ratios, the
      attack skip, the fade gate, the slew limit and the unwrap tolerance should
      each be derived from the noise floor, the sample rate, or the physics,
      or be justified in a comment as to why a constant is right.
- [ ] **Randomised synthetic sweep as a regression gate.** Vary rumble
      frequency, inharmonicity, decay time, microphone response and SNR *wider*
      than one guitar in one room. A change that helps the samples but hurts the
      sweep is overfitting, and the sweep is what will say so.
- [ ] **A second dataset**: another instrument, another room, another phone.
      One guitar is one guitar.
- [ ] **Restore the range below 65 Hz** via an instrument selection (bass,
      cello, piano) that sets the range and filtering, rather than the current
      constant that assumes a guitar.

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

- Nothing below 65 Hz is detected. Deliberate — see the range section of the
  README — but it means no bass guitar until the instrument selection lands.
- All validation is against one guitar, one room, one phone, plus a simulator.

## Done

- [x] Room rumble at 58 Hz was making soft low strings unreadable; steep
      high-pass at 70 Hz and a target-driven search range.
- [x] Notes ended on level alone, cutting soft strings off early.
- [x] Phase unwrapper took a wrong turn on a re-pluck over a ringing string,
      reading 18–32 cents off with full confidence.
- [x] Phase tracking went frenetic as a note died.
- [x] Inharmonicity was estimated relative to a fundamental that is often
      missing; now regressed across every detected partial.
- [x] Trace view, WAV recording on a countdown, and the replay tool.
