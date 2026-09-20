# Plan

`TODO.md` is the list of things to do. This is the argument for what order to do
them in, and what "good" has to mean before we can claim it.

## What good means

Concrete enough to test, because otherwise we will argue about taste:

1. **Right.** Within ±1 cent of ground truth on every sample, within 1.5 s of a
   normal pluck, on every string. (Today: met on three strings of six.)
2. **Quick.** Which way to turn the peg, within 250 ms of the pluck, and never
   wrong. This is a separate goal from being right, not a softer version of it —
   see below.
3. **Honest.** Never shows a confident wrong reading. If it says *In tune*, it is
   within 3 cents. If it does not know yet, it says so and looks like it.
4. **Patient.** Tracks a softly plucked low string for at least 4 seconds without
   losing it or going jumpy at the end.
5. **Portable.** Works for a stranger, on a different guitar, in a noisier room,
   on a different phone. Nothing tuned to one dataset.
6. **Bare.** One screen, no configuration, usable within two seconds of opening.
   A first-time user sees a note and a needle, and nothing else.

Today we are somewhere around 3 or 4 cents on a good string, honest but slow to
commit, and the main screen has three dropdowns on it that exist for debugging.

## Speed and accuracy are not one dial

The obvious framing is a single trade — wait longer, be more right. Measured on
the real samples, that framing is wrong, because *direction* and *magnitude*
become trustworthy at very different times:

```
string   truth    direction right   within 5c   within 1c
  e2    -11.1c        0.26 s          0.94 s      never
  a2     -8.2c        0.26 s          0.47 s      1.63 s
  d3     -6.2c        0.26 s          0.26 s      1.13 s
  g3     -6.3c        0.26 s          0.58 s      never
  b3     -5.1c        0.26 s          0.62 s      never
  e4     +0.8c        0.26 s          0.26 s      1.11 s
```

Direction is right from the first reading the app produces, and stays right.
The precise number takes three to six times longer. So the answer is not to
pick a point on a curve; it is to **say the fast thing as soon as it is known
and the slow thing when it is known**, and to make the difference visible.

Physics supplies an asymmetry worth exploiting. The pluck glide is always
*sharp* — tension rises with amplitude, never falls. So:

- A **flat** reading is trustworthy immediately. The glide can only have pushed
  it up, so a string reading flat is at least that flat, and probably more.
- A **sharp** reading is ambiguous early: it could be a sharp string or it could
  be the glide, and those look identical for the first second.

That gives a provable rule rather than a guess: flat beyond a few cents is
actionable at once; sharp is only actionable once the reading exceeds what the
glide could account for, or once the fit has settled. The bound tightens as
soon as the instrument profile knows this player's own glide.

The practical consequence is that the case where speed matters most — a string
badly out of tune — is also the easy case, because 40 cents flat swamps any
plausible glide. The ambiguity only bites within about 20 cents, which is
exactly where precision matters more than speed anyway.

## The values, and how they trade against each other

Seven things we want. They conflict, so what matters is how conflicts get
settled, not the list.

- **Accurate** — the reading is right.
- **Fast** — it is right *soon*.
- **Stable** — it does not fidget.
- **Responsive** — the app visibly notices the note the instant it is played,
  whether or not it has a reading yet.
- **Robust** — replays, retunes mid-ring, string changes and random noise are
  all handled without drama.
- **Minimalist** — simple, and a pleasure.
- **Illustrative** — a pitch-over-time plot is worth showing if it is simple,
  steady and good-looking.

Three of the conflicts have real resolutions rather than compromises:

**Responsive versus Stable is not actually a conflict** — they are different
channels. Acknowledgement should be instant: the moment a pluck is detected the
app can show the note name, light up, show the level. The *number* can take its
time. Conflating them is why the app currently feels both slow and twitchy; the
fix is to separate them, not to trade one against the other.

**Fast versus Accurate is what the decay fit is for.** The string genuinely is
sharp for the first second, so a fast reading and a true reading really are
opposed — unless the app predicts where the string is heading instead of
waiting. That is the whole argument for the settled-pitch fit, and it is why
Phase 1 matters more than shaving milliseconds anywhere else.

**When they cannot be reconciled, honest-and-slow beats confident-and-wrong.**
A reading the app is not sure of gets shown as unsure. It never claims *In tune*
before it has earned it.

**Minimalist versus Illustrative** is settled by placement, not by cutting: the
main screen carries a note, a needle and nothing else; the plot lives one tap
away. A visualisation is allowed on the main screen only if it never twitches.

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

## Phase 0 — Trust the ruler — **done**

`node tools/score.mjs` scores every mode against real samples and a randomised
sweep, and prints the change against a saved baseline. Truth is ±1 cent with a
known, uniform bias. What follows is the record of what it was.

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

**Standing as of the last run** (error at 2 s on the real samples, median /
p90, and the worst frame-to-frame jump):

```
  Standard   3.1 / 8.5   jump 0.6c      stable but blunt
  Sustain    2.4 / 8.6   jump 7.7c
  Predict    1.6 / 8.6   jump 4.4c      most accurate early, worst tail
  Strobe     2.5 / 5.5   jump 5.3c
  Studio     1.9 / 4.0   jump 1.7c   ←  best balance so far
```

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
**The escape hatch — taken.** The criterion below was met and the hatch was
used; the attempts and the physics are recorded in `TODO.md`. The app now
coaches the pluck instead of modelling the hard one. Original reasoning:

**The escape hatch, decided in advance.** A hard pluck is a harder question
than a soft one — it carries three times the glide and the honest answer is
further away. If the remaining candidates do not close it without constants
tuned to one guitar, the right move is not to keep fitting: it is to support
the moderate pluck properly and *say so*. The app already measures the glide of
each pluck, so it can notice a heavy one and coach it in one quiet line rather
than silently reporting a worse number. **Criterion for taking it:** if after
envelope compensation and the joint harmonic fit the hard-pluck error is still
above 5 cents while normal plucks are inside 2, stop, and spend the effort on
Phase 2 instead. Taking this hatch is a success, not a failure — it is refusing
to overfit.

- Guard against octave errors explicitly. The A2 rumble bug was one, and it
  surfaced as a confident wrong answer rather than a visible failure. A ringing
  string does not change octave mid-note, so that is checkable.
- Then run the bake-off and **pick one default**. Keep the rest as code behind
  the debug door, or delete them; do not keep five modes in a shipped app.
- Expect the answer to be a **staged pipeline rather than a single mode**. The
  latency table above says direction is available long before the settled
  number, and the modes differ in when they first speak at all: MPM reports at
  0.09 s, the phase lock needs 0.24 s to acquire. One pipeline that shows
  direction from the fast estimate and hands over to the settled one is better
  than any single mode, and it is not what "pick a winner" would have produced.

**Done when** one mode is the answer and we can say why, with numbers.

## Phase 2 — Make the number readable

Accuracy we now have some grip on. This is the part you flagged first and it is
still the weakest: *"it was hard for me to tell."*

- Stage the display against the latency table: direction as soon as it is
  known, magnitude when it is, the in-tune claim only once settled. A needle
  that can swing before the number is committed gives the fast answer without
  lying about the slow one.
- Decide what the first second after a pluck shows. It is genuinely sharp then,
  so any number is misleading; the current dimmed-provisional reading is honest
  but ambiguous. Options: show nothing until settled, show a confidence ring
  that closes, or show the settled estimate as soon as the fit is trustworthy
  and never before.
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
