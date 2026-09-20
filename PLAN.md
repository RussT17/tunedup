# Plan

`TODO.md` is the list of things to do. This is the argument for what order to do
them in, and what "good" has to mean before we can claim it.

## What good means

Concrete enough to test, because otherwise we will argue about taste:

1. **Right.** Within ±1 cent of ground truth on every sample, within 1.5 s of a
   normal pluck, on every string.
2. **Honest.** Never shows a confident wrong reading. If it says *In tune*, it is
   within 3 cents. If it does not know yet, it says so and looks like it.
3. **Patient.** Tracks a softly plucked low string for at least 4 seconds without
   losing it or going jumpy at the end.
4. **Portable.** Works for a stranger, on a different guitar, in a noisier room,
   on a different phone. Nothing tuned to one dataset.
5. **Bare.** One screen, no configuration, usable within two seconds of opening.
   A first-time user sees a note and a needle, and nothing else.

Today we are somewhere around 3 or 4 cents on a good string, honest but slow to
commit, and the main screen has three dropdowns on it that exist for debugging.

## The order is forced, not arbitrary

The sequencing matters more than the list, because three dependencies pin it:

- **We cannot choose the best mode until we trust the measurement.** The truth
  tool and the estimator still disagree by 3.4 cents on A2. A bake-off run on a
  ruler that is 3 cents wrong picks the wrong winner.
- **We cannot clean up the UI until we have chosen the mode.** The dropdowns,
  the trace panel and the mode blurbs are all scaffolding for that decision.
  Removing them first would mean rebuilding them.
- **We cannot claim it is portable on one guitar in one room.** Every threshold
  tuned against these 32 files is a chance to overfit, and only a wider test set
  can say whether we did.

So: fix the ruler, pick the algorithm, prove it generalises, then strip the
scaffolding. The cleanup you want is Phase 4 — deliberately last, because it is
the phase that can only be done once.

## Phase 0 — Trust the ruler

Small, and everything else depends on it.

- Resolve the A2 and D3 disagreement between `measure-truth.mjs` and the strobe
  estimator. One of them is wrong by 3+ cents and we do not know which.
- Remove the truth tool's known +0.65 cent bias — residual glide inside the
  analysis window. Start later, or model and subtract the remaining glide.
- Build the randomised synthetic sweep: rumble frequency, inharmonicity, decay
  time, microphone response, SNR, all varied *wider* than one guitar in one
  room. This is the overfitting alarm. A change that helps the samples and hurts
  the sweep is a change that fitted your guitar.
- One command that scores any change against truth across every sample and the
  sweep, and prints a single number plus what regressed.

**Done when** a single command answers "did that change make it better?"

## Phase 1 — Pick the algorithm

The substance. Five modes exist so we could find out which is right; this is
finding out.

- Low E, hard pluck: every mode reads +8 to +9 cents at 2 s. The glide is
  under-corrected on a heavy wound string — the decay grid tops out at 2.6 s and
  a low E's glide is longer.
- Studio over-corrects on some notes (A2 hard: −6.6 where strobe alone got
  −0.2). The trust blend lets the fit run too far.
- B string: strobe and the MPM modes disagree by ~3 cents consistently, in one
  direction. Plain steel, high inharmonicity — suspect the partial correction.
- Three accuracy ideas raised but never built, each a candidate for the
  bake-off rather than an afterthought: a **joint harmonic fit** that solves f0
  and B together across all partials instead of tracking one; an **adaptive
  analysis window** so low strings get more periods and high strings get faster
  response, instead of one fixed 170 ms for everything; and **envelope
  compensation** inside the window, since a note decays while it is being
  analysed and that biases the correlation — worst on exactly the hard-pluck
  case that is worst today.
- Guard against octave errors explicitly. The A2 rumble bug was one, and it
  surfaced as a confident wrong answer rather than a visible failure. A ringing
  string does not change octave mid-note, so that is checkable.
- Then run the bake-off and **pick one default**. Keep the rest as code behind
  the debug door, or delete them; do not keep five modes in a shipped app.

**Done when** one mode is the answer and we can say why, with numbers.

## Phase 2 — Make the number readable

Accuracy we now have some grip on. This is the part you flagged first and it is
still the weakest: *"it was hard for me to tell."*

- Decide what the first second after a pluck shows. It is genuinely sharp then,
  so any number is misleading; the current dimmed-provisional reading is honest
  but ambiguous. Options: show nothing until settled, show a confidence ring
  that closes, or show the settled estimate as soon as the fit is trustworthy
  and never before.
- Needle behaviour: smoothing, settle time, and the ±3 cent in-tune window are
  all currently guesses. Tune them against how it feels while actually tuning.
- A clear "this string is done" moment, and something that tracks progress
  through all six strings without becoming a checklist app.
- Coach the pluck. A softer pluck has less glide to correct, so the app knowing
  that and saying so — once, quietly, when it sees a heavy one — is an accuracy
  improvement disguised as a UI detail.

**Done when** you can tune the guitar without thinking about the app.

## Phase 3 — Prove it travels

- A second dataset: another guitar, another room, another phone, ideally
  recorded by someone who is not us. The recording protocol already exists.
- Instrument profile — record each open string once, store its partial
  signature, inharmonicity, decay and the player's own glide. Then auto-detect
  *which string* is being played from timbre, which deletes the String dropdown
  rather than hiding it, and correct the attack on the first frame instead of
  fitting it every time.
- The remaining room-profile pieces: use it in the strobe's partial choice
  (the case a filter cannot fix — hum sitting on a partial), subtract noise
  power when estimating amplitudes, notch narrowband interferers, and say
  plainly when a room is too noisy to tune in.

**Done when** it works first time for someone else, in their room, with no setup.

## Phase 4 — Strip the scaffolding

The cleanup. Last on purpose: every item here depends on a decision made above.

- Remove the mode dropdown. One mode, no choice.
- Put Trace, Record and mode switching behind a developer door — a long-press on
  the wordmark, or `?debug=1`. They stay useful; they stop being the interface.
- The String selector goes away entirely if Phase 3 lands auto-detection, or
  becomes a quiet affordance if not.
- Fix the accumulated UI oddities: vertical rhythm and the empty space on tall
  screens, the truncating select labels, the settling and held states looking
  too similar, landscape, very small screens, iOS standalone specifics.
- Accessibility: announce readings to a screen reader, respect reduced motion,
  check contrast on the coloured states.

**Done when** a stranger opening it sees one screen and one number.

## Phase 5 — Ship quality

- Service worker update prompt; right now a new version needs a manual reload.
- First run: explain the microphone before asking for it.
- Battery and CPU on a real phone — three FFTs per tick at 25 Hz is fine on a
  laptop and unmeasured on a phone.
- Repo hygiene: `samples/` is 46 MB in git history.

## Explicitly not now

Worth wanting, wrong to start: sweetened and alternate tunings, other
instruments beyond validating that the range works, polyphonic tuning of a
strummed chord, and any kind of account or sync. None of them matter until a
single string reads right on someone else's guitar.
