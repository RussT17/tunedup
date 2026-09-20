# TunedUp — audio processing design

This is a proposed design, not a description of the current code. The current
code is a prototype that worked its way to these conclusions by trial; this
document states what the pipeline should be if it were built again knowing what
that prototype found out. Measurements quoted are from that prototype against
32 real recordings of one guitar, a randomised synthetic sweep, and an
independent ground-truth tool.

It is written to be argued with. Section 10 lists the parts I am least sure of.

---

## 1. What the system has to do

A chromatic tuner running in a browser on a phone, aimed first at guitar.
Targets, in the order they matter:

| | Requirement | Target |
|---|---|---|
| R1 | Accuracy of the reported pitch | within ±1 cent of the string's settled pitch |
| R2 | Time from pluck to a usable reading | ≤ 1 s for a normally plucked string |
| R3 | Stability once settled | ≤ 1 cent of frame-to-frame movement |
| R4 | Acknowledgement that a note was heard | ≤ 100 ms, independent of the reading |
| R5 | Tracking a decaying string | ≥ 4 s on a softly plucked low E |
| R6 | Behaviour under room noise | works with an appliance running |
| R7 | Never a confident wrong answer | an in-tune claim is never made above ±3 cents |

R7 outranks R1. A tuner that occasionally says nothing is usable; a tuner that
occasionally lies is not.

Non-goals for now: polyphony, detecting which string automatically, sweetened
tunings, instruments outside 27–2100 Hz.

---

## 2. What is actually being measured

Three properties of a real plucked steel string drive every design decision
here. Ignoring any of them produces a tuner that is wrong in a way its author
cannot explain.

**2.1 The pitch is not constant.** Displacing a string raises its average
tension, which raises its frequency. The excess decays with the square of the
displacement amplitude, so a pluck starts sharp and glides down. Measured on
this guitar: about +5 cents for a soft pluck and +18 to +25 for a hard one, and
— the part that catches people — it is not a transient. It decays with the
note's own envelope. An independently measured hard low E took **over three
seconds** to arrive within a cent of where it settled; a normal pluck took under
one.

The quantity worth reporting is the zero-amplitude limit: the pitch the string
approaches as it goes quiet, which is also what a very soft pluck reads.

**2.2 The partials are not harmonic.** String stiffness puts partial *m* at

```
f_m = m · f₁ · √( (1 + B·m²) / (1 + B) )
```

with inharmonicity coefficient B. Measured on this instrument: B ≈ 3×10⁻⁵ for
the wound low E rising to ≈ 2×10⁻⁴ for the plain B and high E. At B = 10⁻⁴ the
fourth partial is 1.6 cents sharp of 4f₁ and the eighth is 6.5 cents sharp. Any
estimator that averages partials as though they were harmonic inherits that as a
sharp bias, and the bias changes over the note as the high partials die first.

**2.3 The fundamental is often the weakest thing present.** On an unplugged
solid-body electric radiating acoustically into a phone microphone, the first
partial can sit 10–20 dB below the third. Any method that needs a visible
fundamental will fail on exactly the strings players find hardest to tune.

A fourth property belongs to the room rather than the string: **room noise and
the note usually do not overlap in frequency.** Measured here, every partial of
a *softly* plucked A2 sat 11–39 dB above the room in its own band, while a 58 Hz
rumble — the loudest single component in the room — was louder than the note
below 70 Hz. Whole-signal methods such as autocorrelation nevertheless failed on
it, because a large out-of-band component corrupts the entire correlation
without masking anything. This is a filtering problem, not a detection problem.

---

## 3. Architecture

```
microphone ─► ring buffer (contiguous, absolute sample index)
                 │
                 ├─► DC blocker (20 Hz, 2nd order) ──► analysis frames (hop 10 ms)
                 │                                          │
                 │                                    windowed FFT
                 │                                          │
      room profile ◄──── calibration ──────────────► per-bin SNR mask
                 │                                          │
                 │                             ┌────────────┴────────────┐
                 │                             ▼                         ▼
                 │                    note state machine          partial tracker
                 │                 (quiet/attack/sustain/          (phase-vocoder
                 │                       release)                  per partial)
                 │                             │                         │
                 │                             └────────────┬────────────┘
                 │                                          ▼
                 │                              f₁ and B joint estimate
                 │                                  with variance
                 │                                          ▼
                 │                              settled-pitch model
                 │                                          ▼
                 └────────────────────────────►  single reading + uncertainty
                                                            ▼
                                                    display policy
```

Two things distinguish this from the prototype and both are deliberate.

**Every stage produces an estimate *and* a variance.** The prototype had
twenty-three independent boolean gates that could each suppress a reading, and
the resulting behaviour — notes silently missed — was not attributable to any
one of them. Each of those gates was a crude proxy for "I do not trust this
measurement". Propagating an uncertainty instead collapses them into one number
and one decision, and makes it possible to say *why* a reading was withheld.

**There is exactly one note state machine.** Onset, sustain and release are
decided in one place, from one set of evidence, and every downstream stage reads
that state rather than re-deriving it.

---

## 4. Front end

**Capture.** Mono, device-native rate (44.1 or 48 kHz), with echo cancellation,
noise suppression and automatic gain control all disabled — AGC in particular
destroys the amplitude envelope that section 8 depends on. Audio is taken
through an AudioWorklet into a ring buffer carrying absolute sample indices,
because phase-based estimation needs contiguous samples with known timing and an
AnalyserNode provides neither.

**Filtering.** A second-order high-pass at 20 Hz to remove DC and subsonic
handling noise, and nothing else. Frequency-domain masking (section 5) handles
room noise. A fixed high-pass placed above the noise necessarily also excludes
notes: the prototype's 70 Hz cutoff removed bass guitar entirely and would still
have failed against a rumble at 75 Hz.

**Framing.** Hop 10 ms. Window length chosen from the expected range: 4 periods
of the lowest frequency of interest, rounded up to a power of two, bounded to
[2048, 16384] samples. For guitar that is 4096 at 48 kHz (85 ms); for a 5-string
bass, 16384. A fixed window spends resolution it does not need on high strings
and starves the low ones.

The 10 ms hop is a deliberate choice and section 7 depends on it.

---

## 5. Room model

**What it is.** A per-bin estimate of the power the room produces on its own,
`N[k]`, plus a margin. A bin is admitted to the pitch estimator when
`P[k] > α · N[k]`, with α ≈ 6 (≈ 8 dB). The margin has to clear the room's own
variability, not just its mean: a measured rumble band wandered ±6 dB.

**How it is obtained.** By explicit user action: press and hold a control for
two seconds of audio while the room is averaged. The alternative — inferring it
passively — cannot work, for a reason that is worth stating plainly:

> To learn the room without being told, the system must classify every moment as
> *room* or *note*, with no ground truth. Both errors are damaging.
> Room misread as note produces phantom readings. Note misread as room enters
> the profile, after which that note is masked — the tuner goes deaf to that
> string, silently, and stays deaf.

The second failure is unacceptable and unrecoverable without user action, so the
user is asked for the one fact only they have: that nothing is playing. Holding
the control, rather than tapping it, both proves intent and keeps their hands
off the strings. If a note rings through the calibration anyway it is detectable
(a decaying, strongly periodic signal) and the attempt should be refused.

**Passive maintenance is asymmetric.** Between notes the profile may *lower*
`N[k]` freely, but never raise it. Lowering — the appliance stopped — can only
increase sensitivity. Raising is the direction that masks strings. A room that
has become louder should prompt a recalibration, not perform one.

**Also derived from the profile:** narrowband interferers (mains hum and its
harmonics) can be notched, and a room whose broadband level leaves no partial
with adequate SNR should be reported as untunable rather than tuned badly.

---

## 6. Note state machine

One state variable, four states, driven by evidence that is already computed.

| State | Entered when | Meaning |
|---|---|---|
| `quiet` | admitted power below threshold for 250 ms | nothing playing; room may be learned |
| `attack` | onset detected | a note has begun; acknowledge immediately |
| `sustain` | 150 ms after onset | the note is measurable |
| `release` | admitted power falling and below 2% of peak | decaying; readings still valid but ageing |

**Onset detection** uses two pieces of evidence, because level alone is not
enough. A soft pluck on a new string over one still ringing barely changes the
total level, and in the prototype such notes were simply missed.

1. *Level*: broadband admitted power rises by more than 4.5 dB in 50 ms.
2. *Spectral flux*: `Σ max(0, P[k] − P_prev[k]) / Σ P_prev[k]` over admitted
   bins, exceeding a threshold for two consecutive hops. Measured distribution
   on stitched real sessions: background p95 = 0.27, softest pluck over a
   ringing string = 0.38. The margin is thin, which is why two hops are
   required — background flux is uncorrelated between hops and a real attack is
   not.

A note ends when it is both too quiet to measure *and* no longer periodic, for
250 ms. Ending on level alone cut soft strings off while they were still
perfectly readable.

---

## 7. Pitch estimation

Two stages with different jobs. Conflating them is what produced both the octave
errors and the silent wrong-turn failures in the prototype.

### 7.1 Acquisition — which note is this?

Needs robustness to a missing fundamental, immunity to octave errors, and only
about ±20 cents of accuracy.

Run the normalised square difference function (McLeod) over the **masked**
spectrum — autocorrelation computed by inverse FFT of the gated power spectrum,
so out-of-band room energy contributes nothing. Pick the first NSDF peak
reaching 90% of the tallest, which is the standard defence against choosing a
multiple of the period.

Constrain the lag search to the instrument's range, and to ±400 cents around the
target when the user has selected a string. Accept only above a clarity
threshold.

Octave errors should be treated as a named failure class with its own defences,
because they present as confident wrong answers rather than as visible failures:
the masking above, the first-peak rule, the range constraint, and a continuity
check — a ringing string does not change octave mid-note.

### 7.2 Tracking — exactly what frequency?

Once a note is acquired, estimate each partial's frequency by **phase-vocoder
instantaneous frequency**: for partial *m* occupying bin *k*, the phase advance
between consecutive frames separated by hop *H* gives

```
f = (Δφ + 2πn) / (2π H)
```

The integer *n* is resolved from the bin's own centre frequency. With H = 10 ms
the unambiguous window is ±50 Hz, which no plausible acquisition error
approaches. This matters: the prototype used a long baseline directly, whose
unambiguous window was ±1.7 Hz, and when a re-pluck beat against a still-ringing
note the unwrap took a wrong turn and reported **18 to 32 cents off with full
confidence**. Short hops make that failure mode impossible by construction.

Long-baseline precision is then recovered without the ambiguity by accumulating
unwrapped phase across frames and fitting a straight line to it. Precision
improves with observation time rather than with window length, and the residual
of that fit is a direct, honest variance for the partial's frequency.

Per-partial estimates are combined by the inharmonicity fit below, weighted by
their variances.

### 7.3 Inharmonicity and f₁ together

Taking logs of the stiff-string relation gives a linear model:

```
2·ln( f_m / m )  =  2·ln f₁ + B·m²      (to first order in B)
```

so a weighted least-squares fit of `2 ln(f_m/m)` against `m²` over all tracked
partials yields both `f₁` (intercept) and `B` (slope), and needs no visible
fundamental — which matters given 2.3. Weights come from 7.2.

Two practical requirements, both learned the hard way:

- **At least four partials before B is fitted.** With two points the
  two-parameter fit is exact and absorbs all measurement error into B; doing
  this produced a *negative* — physically impossible — inharmonicity.
- **Reject partials that are not this string's.** Sympathetic ringing from other
  strings and room modes put peaks near `m·f₀` that implied fundamentals 40
  cents out. Solve for the B each candidate would require and discard those
  outside the physical range (0 to ~1.5×10⁻³). This is a physics test, not a
  threshold.

B is worth caching per string in an instrument profile once measured, since it
is a property of the string rather than of the pluck.

---

## 8. Which pitch to report

`f₁` from 7.3 is the string's pitch *at this moment*, which is not the number
the player wants during the first second (section 2.1).

**Model.** The frequency offset decays with the string's energy:
`y(t) = y∞ + A·e^(−t/θ)`. Fitting that and reporting `y∞` gives the settled
pitch early. Two constraints on doing it honestly:

- θ is not free. Since the excess follows the square of the amplitude, it should
  decay in half the note's own time constant. **But** a plucked string's
  envelope is not one exponential: measured on a hard low E it fell 14 dB in the
  first 1.5 s as the high partials died, then 17 dB over the next four. Fitting
  a single exponential to it returns a decay three times too fast. If θ is to be
  derived from the envelope, it must be derived from the *fundamental's*
  envelope — available from 7.2 — not from broadband level.
- The extrapolation must be gated on how much of the decay has actually been
  observed, and faded in with that, not switched on. Reporting a full
  extrapolation from a short span produced 16-cent overshoots.

**Recommendation.** Report the extrapolated settled pitch with its own variance,
fading from the instantaneous value as evidence accumulates. For a normally
plucked string this converges inside 0.5 cents within about a second. For a hard
pluck it does not converge reliably, and the honest response is not a better fit
but a word to the player: the glide amplitude A is measured anyway, so a pluck
above ~15 cents of glide should prompt *"plucked hard — softer settles sooner"*.
That was tested: three separate attempts to model the hard case each made the
normal case worse.

---

## 9. Uncertainty, and the single display decision

Each stage contributes a variance: per-partial phase-fit residuals, the
inharmonicity fit residual, the settled-pitch fit's conditioning, and the SNR of
the admitted bins. These combine into one number, **σ in cents**, and it is the
only thing the display policy consults.

```
σ < 1 cent     → commit: show the reading; claim in-tune if |cents| ≤ 3
1 ≤ σ < 5      → show the reading, visibly provisional, make no in-tune claim
σ ≥ 5          → show the note name only
no note        → acknowledge state only
```

This is the architectural point of the whole document. It replaces a stack of
boolean gates whose interaction nobody can predict with one quantity that can be
displayed, logged, and argued about. When a reading is withheld, the system can
say which term dominated σ.

**Acknowledgement is a separate channel from the reading**, and this is not a
trade-off between responsiveness and stability: the app can show that a pluck
landed within 100 ms and name the note within about 200 ms, while the number
takes as long as it needs. Conflating them makes an app feel simultaneously slow
and twitchy.

---

## 10. Where I am least confident

1. **The variance model.** Combining per-partial phase residuals, fit
   conditioning and SNR into one calibrated σ *in cents* is the part I would
   most expect an expert to tell me is naive. In particular the settled-pitch
   extrapolation's uncertainty is not obviously expressible in the same units as
   a measurement error, since it is model risk rather than noise.
2. **Whether the settled-pitch extrapolation belongs in the product at all**, or
   whether a good tuner should simply report the instantaneous pitch, be honest
   about the glide, and let the player pluck softly. Commercial strobe tuners
   appear to take the latter route.
3. **The spectral-flux onset threshold.** Background p95 0.27 against a softest
   pluck of 0.38 is thin, from one guitar in one room.
4. **Whether masking bins below the room profile biases the NSDF.** It removes
   energy the note may also occupy, and I have not characterised the effect on
   the peak position, only observed that it fixes octave errors.
5. **Phase-vocoder tracking of partials that are close to a room mode or to
   another string's partial.** The design assumes partials are resolvable; a
   sympathetically ringing neighbour a few Hz away is the case that worries me.
6. **CPU on a mid-range phone.** A 10 ms hop with a 4096-point FFT plus
   per-partial tracking is roughly 3× the prototype's load, which was never
   profiled on a phone at all.

---

## 11. Validation

No change ships without measurement against all three:

- **Synthetic sweep** — randomised plucks with known pitch, varying frequency,
  pluck strength, decay, inharmonicity, microphone roll-off, noise, and a room
  rumble at random frequency and level, deliberately wider than one instrument
  in one room. This is the overfitting alarm: a change that improves the real
  recordings and worsens the sweep has fitted one guitar.
- **Real recordings** — 32 takes across six strings, scored against ground truth
  measured by a tool that shares no code with the estimators (long windows
  contained wholly inside the note, partial-series fit, ±1 cent with a known
  +0.85 cent bias that is uniform across strings and so cancels in comparisons).
- **Stitched sessions** — those recordings spliced into whole sessions with
  re-plucks, string changes, silences and an appliance that stops partway, graded
  on glitches rather than accuracy: notes missed, readings invented in silence,
  wrong strings, frame-to-frame jumps. Every failure the user reported from real
  use appeared here and nowhere else.
