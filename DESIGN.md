# TunedUp — audio processing design

A proposed design, not a description of the current code. The current code is a
prototype that reached these conclusions by trial; this states what the pipeline
should be if it were built again knowing what that prototype found out.
Measurements quoted come from that prototype against 32 real recordings of one
guitar, a randomised synthetic sweep, and an independent ground-truth tool.

Revision 4, after three rounds of design review. Section 12 lists what remains
uncertain.

---

## 1. What the system has to do

A chromatic tuner running in a browser on a phone, aimed first at guitar.

| | Requirement | Target |
|---|---|---|
| R1 | Accuracy of the reported pitch | within ±1 cent of the string's settled pitch |
| R2 | Time from pluck to a usable reading | ≤ 1 s for a normally plucked string |
| R3 | Stability once settled | ≤ 1 cent of frame-to-frame movement |
| R4 | Acknowledgement that a note was heard | ≤ 100 ms, independent of the reading |
| R5 | Tracking a decaying string | ≥ 4 s on a softly plucked low E |
| R6 | Behaviour under room noise | works with an appliance running |
| R7 | Never a confident wrong answer | an in-tune claim is never made above ±3 cents |

R7 outranks R1, and it is a statement about *probability*, not about the point
estimate: §10 turns it into `|cents| + 2σ ≤ 3`. A tuner that occasionally says
nothing is usable; a tuner that occasionally lies is not.

**Out of scope, stated plainly:** polyphony, automatic string identification,
sweetened tunings, instruments outside 27–2100 Hz, and **acoustic capture in a
live band** — when the interferer is another guitar playing the same note, no
amount of masking helps, and the answer is an input device (§11.3), not an
algorithm.

---

## 2. What is actually being measured

Three properties of a real plucked steel string drive every decision here.

**2.1 The pitch is not constant.** Displacing a string raises its average
tension, which raises its frequency. The excess is *proportional to* the square
of the displacement amplitude, so a pluck starts sharp and glides down.
Measured on this guitar: about +5 cents for a soft pluck, +18 to +25 for a hard
one — and it is not a transient. An independently measured hard low E took
**over three seconds** to come within a cent of where it settled; a normal pluck
took under one.

Because the excess goes as amplitude squared, it decays at the same rate as the
signal's *power* envelope, i.e. with half the time constant of its *amplitude*
envelope. Any code touching this must say which envelope it means; conflating
them is a factor-of-two error in the decay rate, and a factor of two here was
worth 16 cents of overshoot in the prototype.

**2.2 The partials are not harmonic.** String stiffness puts partial *m* at

```
f_m = m · f₁ · √( (1 + B·m²) / (1 + B) )
```

normalised so `f₁` is the actual first partial rather than a fictitious
non-stiff fundamental. Measured on this instrument: B ≈ 3×10⁻⁵ for the wound low
E rising to ≈ 2×10⁻⁴ for the plain B and high E. At B = 10⁻⁴ the fourth partial
is **1.30** cents sharp of 4f₁ and the eighth is **5.44** cents sharp. An
estimator that averages partials as though they were harmonic inherits that as a
sharp bias — and one that *changes over the note*, because the high partials die
first.

**2.3 The fundamental is often the weakest thing present.** On an unplugged
solid-body electric radiating into a phone microphone, the first partial can sit
10–20 dB below the third. Any method that requires a visible fundamental fails
on exactly the strings players find hardest to tune.

A fourth property belongs to the room: **room noise and the note usually do not
overlap in frequency.** Every partial of a softly plucked A2 sat 11–39 dB above
the room in its own band, while a 58 Hz rumble — the loudest single component in
the room — was louder than the note below 70 Hz. Autocorrelation still failed on
it, because a large out-of-band component corrupts the whole correlation without
masking anything. A filtering problem, not a detection problem.

---

## 3. Architecture

```
microphone ─► worklet: DC blocker (streaming) + copy
                  └─► ring buffer, absolute sample index
                                          │
              ┌───────────────────────────┴──── worker ────────────────────┐
              │                                                            │
              ▼                                                            │
            frames, 10 ms hop ─► window ─► FFT                             │
                                                  │                        │
                  room profile ◄──────────────────┤                        │
                  (min-statistics + manual)       │                        │
                                                  ▼                        │
                                        per-bin admission mask             │
                                                  │                        │
                          ┌───────────────────────┼──────────────────┐     │
                          ▼                       ▼                  ▼     │
                 note state machine      acquisition (NSDF)    partial     │
                 quiet/attack/                on gated          tracker    │
                 sustain/release            time signal       (heterodyne) │
                          │                       │                  │     │
                          └───────────────────────┴────────┬─────────┘     │
                                                           ▼               │
                                            joint f₁ / B fit + covariance  │
                                                           ▼               │
                                        ┌──────────────────┴────────────┐  │
                                        ▼                               ▼  │
                            hypothesis validity gates              σ (cents)│
                         (octave · polyphony · course ·                 │   │
                          clipping · beating · profile)                 │   │
                                        └──────────────┬────────────────┘   │
                                                       ▼                    │
                                             display policy  ◄──────────────┘
```

**Two layers, not one number.** An earlier draft of this document proposed
reducing every quality judgement to a single σ in cents. That is half right, and
the half that is wrong matters. Three different things were being conflated:

1. **Statistical noise** — phase-fit residuals, SNR. Genuinely a variance,
   propagates correctly, and is calibratable.
2. **Model misspecification inside the accepted model** — the inharmonicity fit.
   Handled as χ²/dof, inflating the covariance by √(χ²/dof). Note the limitation:
   a self-consistent *wrong* fit has a small residual.
3. **Known-sign correctable bias** — the residual pitch glide (§8) and the
   tracker's group delay (§7.2). Both are measured, both are *always in the same
   direction*, and burying either in a symmetric σ is a mistake with a concrete
   cost: a player who tunes until the reading reads zero leaves the string flat
   by that amount, every time. These are corrected or displayed asymmetrically,
   never averaged into σ. (The sample-clock offset is *not* in this category: its
   sign and magnitude are both unknown, so a symmetric floor on σ is the honest
   treatment.)
4. **Categorical failures** — wrong octave, two notes at once, a 12-string
   course, clipping, a stale room profile, platform AGC left on. **These have no
   variance representation at all.** A wrong-octave answer has σ ≈ 0.2 cents and
   is 1200 cents wrong. Reducing everything to σ hides precisely the failure R7
   exists to prevent.

So: a **small, named set of hypothesis-validity gates** decides whether the
question is even the right one, σ measures precision *within* the accepted
hypothesis, and known-sign biases are corrected rather than absorbed. The prototype's problem was not that gates existed — it was that
there were twenty-three of them, undocumented, and nothing recorded which one
suppressed a reading. The cure is to reduce them, name them, and **log which one
fired**, not to pretend a categorical failure is a variance.

---

## 4. Capture, threading, framing

**Capture.** Mono, device-native rate, with `echoCancellation`,
`noiseSuppression` and `autoGainControl` requested off — AGC in particular
destroys the amplitude envelope §9 depends on. These are *requests*: several
platforms honour them only for some sources and some apply a high-pass
regardless. Read back `track.getSettings()`, and treat the room calibration as a
processing probe — AGC shows as level pumping on a decaying note, a platform
high-pass as attenuation of the low partials. Tell the user when detected.

**Threading.** The AudioWorklet runs the DC blocker (below) and copies samples
into the ring buffer, and nothing else. A 4096-point FFT inside a 2.67 ms render quantum causes dropouts, and a
dropout puts a **gap in the phase record**, which is fatal to §7.2. All analysis
runs in a Worker over a SharedArrayBuffer. SAB requires cross-origin isolation
(COOP + COEP), which is a real constraint on a PWA and precludes third-party
embedding; where it is unavailable, fall back to transferring copies via
`postMessage`, accepting extra latency and allocation churn. Pre-allocate every
buffer; allocating 4096-float arrays a hundred times a second produces periodic
GC pauses that look exactly like dropouts.

**Discontinuities.** The absolute sample index exists to be *used*. Any gap,
device change, sample-rate change, route change, or backgrounding must be
detected as an index discontinuity and must reset the phase accumulator, the
partial tracker and the §9 fit. Without this the tuner silently reports garbage
after a headphone is unplugged.

**Clipping.** A hard pluck near a phone microphone clips. Clipping generates
harmonic distortion at *exact integer ratios* — a perfectly harmonic fake series
superimposed on the real inharmonic one, which pulls B̂ toward zero, biases f₁,
and does so with a *low* fit residual. That is a confident wrong answer, so it is
a §10 gate, not a σ term. Detect by sample magnitude and by sustained
flat-topping, and refuse the frame.

**Filtering.** A second-order high-pass at 20 Hz for DC and subsonic handling
noise, and nothing else. It runs **streaming on ingest**, in the worklet's copy
path, once per sample. A second-order IIR carries state; running it per
analysis frame would either re-filter the same samples with the wrong state or
produce a discontinuity at every frame boundary, and the heterodyne path of
§7.2 is time-domain and needs the real filter rather than a zeroed bin. Frequency-domain masking (§5) handles room noise. A
fixed high-pass placed above the noise necessarily also excludes notes: the
prototype's 70 Hz cutoff removed bass guitar entirely and would still have failed
against a rumble at 75 Hz.

**Framing.** Hop 10 ms, which §7.2 depends on. Window length is set by a
**resolution criterion**: a Hann main lobe is 4/T wide null-to-null, so resolving
partials spaced f₁ apart needs T ≥ 4/f₁ — four periods of the lowest note — and
that is the *marginal* case, with adjacent partials sitting exactly on the nulls.
Use six to eight periods where latency allows:

| Instrument | Lowest f₁ | 4 periods | Chosen | Window duration |
|---|---|---|---|---|
| Guitar | 82.4 Hz | 2330 | 4096 (7.0 periods) | 85 ms |
| 5-string bass | 30.9 Hz | 6220 | 12288 (7.9 periods) | 256 ms |

12288 is 4096×3 — a mixed-radix size, not a power of two, chosen because 8192
gives only 5.3 periods (outside the rule) and 16384 gives 10.5 at the cost of
85 ms more latency.

**This window governs acquisition latency only.** Tracking latency is set by the
partial filter of §7.2 — about 49 ms on guitar and 130 ms on bass for the Hann
integrator recommended there, or 54–88 ms and 144–235 ms for a designed FIR
depending on the stopband. Decoupling the two is a real benefit of heterodyne
tracking but a **modest one, roughly a factor of two**, not the factor of four
an earlier revision claimed on the strength of an unachievable `1/BW` figure: a
bass note is tracked in ~130 ms behind a 256 ms acquisition window, and at a
60 dB stopband the advantage disappears entirely. Acquisition may also run at
10–20 Hz rather than every hop; only the partial tracker needs the full rate.

**Window function.** Hann for the phase path. For the detection and masking
spectrum use a low-sidelobe window (Nuttall or Blackman–Harris): §2.3 says the
fundamental can sit 20 dB below the third partial, and Hann's −31 dB first
sidelobe from a strong partial can swamp a weak one and corrupt the mask.

---

## 5. Room model

**What it is.** A per-bin estimate `N[k]` of the power the room produces on its
own. A bin is admitted when `P[k] > α·N[k]`, α ≈ 6 (7.8 dB). The margin must
clear the room's own variability, not just its mean: a measured rumble band
wandered ±6 dB.

**α is traded against R5, not fixed.** R5 asks for four seconds of tracking on a
softly plucked low E, and §2 measures such partials at 11–39 dB above the room.
A partial at the bottom of that range has only 3.2 dB of headroom over a 7.8 dB
threshold and is masked within about a second; holding a reading for four
seconds needs roughly 12 dB of headroom, i.e. ~20 dB above the room, on at least
two partials — *after* mains exclusion, beating de-weighting and B-plausibility
rejection have taken their cut. Every revision of this design has added
partial-removing machinery and none has checked it against R5. So α is a
parameter with R5 on one side and false admission on the other, and §13 measures
tracking duration directly rather than assuming it.

**How it is obtained — minimum statistics, with a manual override.** An earlier
draft argued that passive inference "cannot work", because a classifier that
mistakes a note for the room enters it into the profile and the tuner then goes
deaf to that note, silently and permanently. That argument is sound against a
classifier or a mean, and wrong in general: **minimum-statistics noise tracking**
(Martin) takes a running minimum of smoothed power per bin over a multi-second
window, and is *structurally incapable* of learning a note, because a note raises
a bin and a minimum ignores raises. It requires the standard bias compensation
(the minimum of a noisy sequence underestimates its mean) and it only fails for a
continuously sounding tone, which a decaying plucked string is not.

So: minimum statistics is the primary mechanism, with the **never-raise** rule
retained on top of it. Window length matters to its safety and is specified at
**~30 seconds with bias compensation**: Martin's typical 10–15 s is marginal
here, because a tuning session is pluck-adjust-pluck and the low bins may not
see a 10 s gap. It runs unconditionally rather than being gated on the note
state machine — gating it would reintroduce the classifier this section rejects,
and would create a mask → state → mask loop.

Manual calibration — hold a control for two seconds while the room is averaged —
is kept for two reasons: it is the *immediate* re-baseline when the room changes
abruptly, which is what minimum statistics is slowest to follow, and a
diagnosable product needs a user-invocable reset that demonstrably changes
something when the tuner misbehaves. The handoff must be defined or the two
mechanisms fight: **manual calibration replaces `N[k]` and clears the
minimum-statistics history**, so the retained old minima cannot immediately
override the manual value. The manual path must also refuse to calibrate when a
note rings through it — a decaying, strongly periodic signal during calibration
is detectable, and learning it would be exactly the failure above.

**Staleness, and what happens during a rebuild.** A profile has a lifetime.
Timestamp it; invalidate on device change, on sample-rate change, and on a new
session, because a profile learned at home and applied at a gig masks the wrong
things.

Invalidation must not deafen the tuner for the thirty seconds minimum statistics
needs to rebuild — plugging in headphones should not stop it working. On
invalidation the tuner **runs on the rebuilding estimate with an inflated α**
and raises the soft `stale` gate until the estimate matures. The hard `room`
gate is reserved for the one case that genuinely cannot be worked around: fewer
than two partials clearing the margin.

**Mains.** Detect the mains frequency (50 or 60 Hz) from the profile and mark
partials within about one bin of it and its harmonics **unusable**, rather than
notching blindly. This matters most for bass: the second partial of a low B sits
at 61.7 Hz, within 1.7 Hz of 60 Hz mains.

**Untunable rooms.** If fewer than two partials clear the margin, say so. "Too much
background noise to tune here" is a better product than a confident wrong number.

---

## 6. Note state machine

One state variable, four states, driven by evidence already computed.

| State | Entered when | Meaning |
|---|---|---|
| `quiet` | admitted power below threshold for 250 ms | nothing playing |
| `attack` | onset detected | a note has begun; acknowledge immediately (R4) |
| `sustain` | the partial filter of §7.2 has settled (≈50 ms guitar, ≈130 ms bass) | the note is measurable |
| `release` | first partial's envelope falling, below 2% of its peak | decaying; readings valid but ageing |

**Onset detection** uses two pieces of evidence, because level alone is not
enough: a soft pluck on a new string, over one still ringing, barely changes the
total level, and in the prototype such notes were simply missed.

1. *Level*: broadband admitted power rises more than 4.5 dB in 50 ms.
2. *Spectral flux*, computed on **log magnitude** rather than power, and
   restricted to **bins not explained by the current note's partial model**.

Both refinements matter. Power-domain flux is dominated by the loudest partial
and is therefore highly sensitive to amplitude modulation — and two nearly
in-tune strings *beat*, which is what tuning produces, giving periodic power
rises indistinguishable from an onset. Log magnitude is far better behaved, and
restricting to unexplained bins is enormously more discriminative than broadband
flux, since a new note is precisely energy at frequencies the current note does
not explain. The prototype's broadband power flux gave a background p95 of 0.27
against a softest-pluck value of 0.38 — a margin too thin to use, which is the
evidence for changing the statistic and **not** a threshold for the new one.

**The threshold for the new statistic must be derived empirically against §13,
not inherited**, exactly as §7.1 says of McLeod's clarity thresholds. Two
regimes need separate numbers, because they are different detectors:

- *From `quiet`*: there is no current partial model, so "bins not explained"
  is every bin and the statistic degenerates to broadband log flux against the
  room profile.
- *Over a ringing string*: the partial model exists and does the work, and this
  is the regime the old statistic failed in.

The two-consecutive-hops requirement is retained in both, because background
flux is uncorrelated between hops and a real attack is not. R4 is unimplementable
until both thresholds have numbers, and §12 keeps that open.

The release test uses the **first partial's** envelope from §7.2 rather than
broadband power, for the reason §9 gives: a broadband envelope falls steeply
while the high partials die and then slowly, so a broadband threshold declares
release early on exactly the notes that sustain longest.

A note ends when it is both too quiet to measure *and* no longer periodic, for
250 ms. Ending on level alone cut soft strings off while they were still
perfectly readable.

---

## 7. Pitch estimation

Two stages with different jobs. Conflating them produced both the octave errors
and the silent wrong-turn failures in the prototype.

### 7.1 Acquisition — which note is this?

Needs robustness to a missing fundamental, immunity to octave errors, and only
about ±20 cents of accuracy.

**Gate, then compute a true NSDF on the gated signal.** McLeod's function is

```
n(τ) = 2·r(τ) / m(τ),   m(τ) = Σ ( x[j]² + x[j+τ]² )
```

and `m(τ)` is a running sum over time-domain samples — it **cannot** be obtained
from a gated spectrum. Computing `r(τ)` spectrally while taking `m(τ)` from the
ungated signal leaves `n(τ)` unbounded, and the clarity threshold and the 90%
rule lose McLeod's meaning. Worse, `m(τ)` is exactly what removes the ACF's
`1 − τ/N` taper, and that taper biases lag selection toward *short* lags — that
is, toward **octave-up** errors, which §2.3's missing fundamental already makes
the likely failure.

Concretely, and it is only two transforms rather than four: `r(τ) = IFFT(|X̃|²)`
comes directly from the gated spectrum `X̃`, and a single inverse transform of
`X̃` gives the gated signal `x̃`, whose cumulative sums of `x̃²` form `m(τ)`. Both
terms then derive from the same gated signal, which is the consistency this
section is about.

Three implementation requirements that are easy to get wrong:

- **Re-zero the pad.** Gating the spectrum is convolution in time with the
  mask's impulse response, so the gated signal's energy spreads across the whole
  buffer *including the zero-pad region*. "Zero-pad to 2N" therefore does not
  prevent wraparound on its own: re-zero samples N…2N−1 after the inverse
  transform and before forming `r(τ)`, or pad to 4N.
- **Use a soft gain, not a binary mask, on this path.** A hard 0/1 mask rings —
  sinc tails around every retained band, the classic spectral-gating artifact.
  Use `g[k] = max(0, 1 − α·N[k]/P[k])`, smoothed across bins — continuous with
  the hard mask, since it reaches zero exactly at the admission threshold. The
  hard mask is still the right thing for *selecting* partials in §7.2; it is the
  wrong thing for a signal that will be autocorrelated. Note the cost: this
  attenuates a partial 11 dB above the room by 5.6 dB and one 15 dB above by
  1.8 dB, so the clarity recalibration below is doing more work than it appears
  and the resulting threshold is SNR-dependent.
- **Say which frame the NSDF sees.** The analysis frame is windowed before the
  FFT, so `x̃` carries a taper. `m(τ)` compensates most of it, since it
  normalises by the actual overlap energy, but not exactly, and McLeod's clarity
  thresholds assume a rectangular frame. The NSDF path uses the **Hann-windowed**
  frame and its clarity thresholds are calibrated against that, not inherited.

**Peak selection.** Take the first NSDF peak reaching 90% of the tallest
(McLeod's k, 0.8–1.0). Note what this defends against: choosing a *multiple* of
the period, i.e. octave-*down*. It is the wrong direction for the error §2.3
creates, which is why the normalisation above and the comb check below are the
load-bearing defences.

**Octave errors are a named failure class**, because they present as confident
wrong answers rather than visible failures. Four defences:

- correct NSDF normalisation (above), which removes the short-lag bias;
- first-peak-at-90%, against the opposite error;
- range constraint: the instrument's range, and **±200 cents** around the target
  when a string is selected — not ±400, since G→B is exactly 400 cents and a
  ±400 window around G accepts B;
- a **harmonic-comb GCD check**: if the admitted partials' implied harmonic
  numbers share a common factor (masking may leave only 4, 6, 8), the period
  looks halved and every other defence passes. Test for gcd 1 explicitly.

That last point also answers whether masking biases the NSDF peak: gating
changes peak height and shape but not position, *provided* the surviving
partials have gcd 1. That is a test, not an assumption.

### 7.2 Tracking — exactly what frequency?

Once acquired, track each usable partial by **complex heterodyne**: mix the
partial down to baseband at its current frequency estimate, low-pass, and take
the residual phase slope. This has no bin boundaries — a partial drifting across
one would corrupt a bin-indexed phase accumulator — no integer ambiguity to
resolve, and it yields the per-partial **amplitude envelope** (§8 and §9 need it)
and **amplitude modulation** (the beating detector below) for free. The FFT
remains for masking, flux and acquisition.

It is *more* expensive than reading an FFT bin, not less: a complex multiply per
input sample per partial, roughly 4.6 Mflop/s for sixteen partials at 48 kHz,
against O(1) for a bin lookup on an FFT already being computed. It is chosen for
correctness, and §12.11 establishes that a few Mflop/s is irrelevant. Decimate
the baseband aggressively — only ±f₁/2 is needed — so that only the mix stage
runs at full rate; a CIC or moving-average decimator makes the post-mix work
multiplier-free.

**The low-pass must be specified, because three other claims rest on it.** Two
parameters are design, not implementation, and an implementer cannot produce the
right filter without them.

*Passband.* Half-bandwidth f₁/2, so the neighbouring partial sits at the band
edge: 41 Hz for a low E, 15 Hz for a low B. The transition band is therefore
BW → 2·BW, as wide as the passband itself, which is what makes this filter
expensive. Acquisition precision is sufficient to start it: ±20 cents at m = 16
is 37% of the passband for both guitar and bass.

*Stopband — derived, not chosen.* Leakage from the neighbouring partial at
relative level ε perturbs the measured phase by up to ε radians, giving a
frequency error of about `ε/(2πT)` over a fit span T. Setting that against the σ
budget, and adding the 10–20 dB by which §2.3 says the neighbour may be *louder*
than the partial being tracked, lands near **60 dB**. That is the number the
filter must meet, and it is why the bass case is tight.

*Consequent latency.* For a linear-phase FIR the Kaiser estimate
`N ≈ (A−8)/(2.285·Δω)` gives settling ≈ `A_dB / (22·Δf)`:

| | 40 dB | 60 dB | Hann integrator, T = 4/f₁ |
|---|---|---|---|
| guitar low E | 54 ms | 88 ms | 49 ms |
| bass low B | 144 ms | 235 ms | 130 ms |

An earlier revision quoted 24 ms and 65 ms. Those are the `1/BW` lower bound and
are **not achievable** at any useful rejection; the figures above replace them,
and §4's decoupling claim is restated accordingly.

*Recommended structure.* A **Hann-windowed integrate-and-dump at the partial
frequency, T = 4/f₁**. This is the same object as an FFT bin evaluated at an
arbitrary re-centred frequency, so it keeps every correctness argument for
heterodyne — no bin quantisation, no bin migration, arbitrary centre — while
collapsing the tracking filter and the analysis window into one structure with
one latency, and T = 4/f₁ is §4's own four-periods resolution rule arriving from
the other direction. It places the neighbouring partial on a window null, giving
rejection far better than Hann's −31 dB sidelobe; inharmonicity shifts the
neighbour slightly off that null, which is the residual to characterise.

*Re-centring.* The mix frequency must be re-centred as the estimate improves, or
the partial drifts onto the skirt where group delay varies and the phase slope
is biased.

*Group delay is a known-sign bias and must be removed.* The filter delays the
tracker output by a known constant, so on a falling pitch the reported frequency
is **sharp** by `delay × |df/dt|` — 0.22 cents at 44 ms and 5 cents/s, 1.18
cents at 118 ms and 10 cents/s — compounding with §8's glide bias in the same
direction. The ring buffer already carries absolute sample indices: timestamp
the tracker output at `now − group delay` and it vanishes. This is the payoff of
a decision §4 made and had never cashed.

**Fit a quadratic phase model, not a line.** §2.1 says the pitch chirps downward
for seconds. Phase under a chirp is quadratic; fitting a straight line recovers
the mean frequency over the span but inflates the residual with a systematic
term, so σ is worst exactly when §8 needs it most. A quadratic model — frequency
plus chirp rate — costs one basis function, keeps the residual an honest noise
estimate, and hands §8 the glide rate directly.

**The variance must be corrected for correlated residuals.** Successive phase
samples are not independent, so treating them as such understates the slope
variance and hence σ — and since R7 depends on σ being trustworthy, an
optimistic σ is a direct threat to the top requirement. With bin-indexed
tracking the correlation came from overlapping FFT frames; with heterodyne it
comes from the **low-pass impulse response**, and the inflation is approximately
`√(L/D)` for an effective filter length L and output interval D. The figure
therefore follows from the filter specified above rather than from a window
length, and must be derived from it — or, failing that, measured by the
reliability diagram of §10 and applied as a calibrated factor. Either way the
document must state which, because an uncorrected σ here is the most direct
route to violating R7.

**Beating is a named gate, not a variance.** An earlier draft claimed that a
10 ms hop makes unwrap failure "impossible by construction". That is false and
the claim is retracted. The arithmetic is right — the unambiguous window is
±1/2H = ±50 Hz, against ±1.7 Hz for the 294 ms baseline the prototype used, and
no plausible acquisition error approaches 50 Hz. But the failure actually
suffered was **a re-pluck beating against a still-ringing note**, and beating
does not respect that margin: where two components a few Hz apart share a band,
the observed phase is that of their vector sum, which near a beat null slews
arbitrarily fast and can traverse π in a single hop at any hop length. Short hops
make the failure *rarer*, not impossible.

The defence is the amplitude modulation that beating necessarily produces — but
it must **discriminate**, not threshold on monotonicity. A single plucked
string's partial envelopes are routinely non-monotonic: the two transverse
polarisations couple at the bridge and beat at a fraction of a hertz to a few
hertz. That is ordinary guitar behaviour, and a gate that fires on it would
discard most partials on most notes, which is a worse outcome than the failure
it prevents and would present as a tuner mysteriously refusing good plucks.

The two cases separate on depth, rate and coherence: own-string polarisation
beating is slow, shallow, and affects the whole partial series coherently, while
a foreign partial's beating is confined to one partial and is usually deeper and
faster. Gate on modulation depth and rate, restricted to partials that beat
*incoherently* with the rest of the series, and **de-weight rather than drop** —
the χ² and robust regression of §7.3 already handle a noisy partial gracefully,
and §12 notes that on a bass there may be few partials to spare.

**Use a location prior as well as a detector.** When the user has selected a
string the tuner knows the intended tuning, and therefore knows where the other
strings' partials will land — the coincidences in standard tuning are
predictable. De-weight those locations in advance rather than relying solely on
catching contamination after the fact. This is the same move as §7.3's
B-plausibility test: prefer a physical prior to a tuned threshold.

### 7.3 Inharmonicity and f₁ together

Taking logs of the stiff-string relation:

```
2·ln( f_m / m )  =  2·ln f₁ + ln(1 + B·m²) − ln(1 + B)
                 ≈  ( 2·ln f₁ − B ) + B·m²
```

A weighted fit against `m²` yields both, and needs no visible fundamental —
which is the answer to §2.3 and the strongest idea in this design. Six
requirements, each of which was learned by getting it wrong:

- **Evaluate the fitted line at m² = 1, not at the intercept.** At m² = 0 the
  value is `2 ln f₁ − B`, which biases f₁ sharp by `1200·B / (2 ln 2)` cents —
  0.17 cents at B = 2×10⁻⁴. Systematic, string-dependent, and free to remove:
  at m² = 1 the correction terms cancel exactly.
- **Weight in the log domain.** The fit is over `2 ln(f_m/m)`, whose variance is
  `4σ²_fm / f_m²`, not `σ²_fm`. Phase-based frequency variance is roughly
  constant in Hz across partials, so log-domain weights scale as `f_m²` and high
  partials dominate by two orders of magnitude. Good for estimating B; but f₁ is
  then an *extrapolation* from high m² back to m² = 1, with high leverage and
  strong f₁/B anticorrelation, where one contaminated partial moves f₁ several
  cents at low residual.
- **Therefore use robust regression** (IRLS with a Huber loss) plus
  leave-one-out, not plain weighted least squares.
- **Report σ(f₁) from the sandwich covariance evaluated at m² = 1**, not from the
  naive weighted covariance and not from the residual alone, so both the f₁/B
  anticorrelation and the robustification are accounted for. A naive covariance
  after IRLS is optimistic, which R7 cannot afford.
- **Compute χ² on the pre-robustification residuals.** §10 inflates σ by
  √(χ²/dof) to account for model misfit, but IRLS exists to down-weight exactly
  the outliers that raise χ² — so a naive ordering lets the robust fit silently
  disable the misfit detector that is supposed to notice contamination. Evaluate
  χ² before down-weighting, and pass the count and magnitude of down-weighted
  partials to the gates of §10 as a separate signal.
- **At least four partials before B is fitted.** With two points a two-parameter
  fit is exact and absorbs all measurement error into B; doing this produced a
  *negative* — physically impossible — inharmonicity.
- **One Gauss–Newton refinement on the exact model**, seeded with the linear B̂.
  The first-order truncation costs 0.07 cents at m = 8, 0.35 at m = 12 and 1.1 at
  m = 16 **for B = 2×10⁻⁴**, the worst (plain, high) string; at B = 3×10⁻⁵ for a
  wound low E the m = 16 figure is 0.025 cents, forty-four times smaller. It is
  curvature, so it tilts the fit rather than averaging out. Two iterations of a
  two-parameter fit cost nothing.

**Foreign partials are rejected by physics, not by a threshold.** Sympathetic
ringing from other strings and room modes put peaks near `m·f₀` that implied
fundamentals 40 cents out. Solve for the B each candidate would require and
discard those outside the physical range (0 to ~1.5×10⁻³).

B is cached per string in an instrument profile, since it is a property of the
string rather than of the pluck — and invalidated when strings are changed,
because a stale B is a silent bias.

**When fewer than four partials survive.** Mains exclusion (§5), the beating
gate (§7.2) and the B-plausibility test all remove partials, and on a bass the
fundamental and often the second partial are inaudible on a phone microphone to
begin with. This is not a corner case and needs defined behaviour:

| Partials surviving | Behaviour |
|---|---|
| ≥ 4 | joint f₁/B fit as above |
| 2–3, cached B available | f₁-only fit at the cached B, σ inflated by the cached value's own uncertainty |
| 2–3, no cached B | f₁-only fit at B = 0, σ inflated by an **instrument-class B prior** and by the **harmonic numbers that actually survived** (see below) |
| < 2 | `room` gate: refuse and say why |

The inflation for the B = 0 rung must use an instrument-class prior — B ≤ 2×10⁻⁴
for a steel-strung guitar — and **not** the 0 to 1.5×10⁻³ range used to reject
foreign partials, which is a much wider bound serving a different purpose. The
difference decides whether the rung works at all, and it depends strongly on
*which* partials survived:

| Surviving partial | cost of assuming B = 0, at B = 2×10⁻⁴ | at 1.5×10⁻³ |
|---|---|---|
| m = 2 | 0.52 cents | 3.9 |
| m = 3 | 1.38 | 10.3 |
| m = 4 | 2.59 | 19.2 |
| m = 5 | 4.14 | 30.6 |

Against the rejection bound the rung is dead — σ ≥ 5 always, so §10 would show
only a note name and never a reading. Against the instrument-class prior, and
weighted toward whichever low partials survived, it is usable. Surviving at low
m is worth an order of magnitude over surviving at high m, and the fallback's
value turns entirely on that.

---

## 8. Which pitch to report

**Report the instantaneous pitch. Do not extrapolate.**

An earlier draft proposed fitting `y(t) = y∞ + A·e^(−t/θ)` and reporting the
settled value. The argument against it is in the measurements: a normal pluck
settles within a cent in under a second, which already meets R2 *without*
extrapolation, while the hard pluck — the only case where prediction would pay —
is exactly where the fit does not converge reliably, and three separate attempts
to make it converge each made the normal case worse. **A feature that is
unnecessary where it works and fails where it would be valuable is a feature to
delete.**

It is also what every commercial tuner does. A strobe display *is* an
instantaneous frequency-error indicator whose visual integration does the
averaging, and the player's own protocol — pluck, wait, adjust — discounts the
glide for free. Prediction is model risk, which is unbounded, not expressible in
cents, and precisely the way to violate R7.

**But keep the measurement, and use it as a bound rather than a prediction.**
The quadratic phase fit of §7.2 yields the chirp rate `df/dt` directly, and for
an exponentially decaying glide the remaining error is not merely *related* to
that rate — it is determined by it:

```
y(t) = y∞ + A·e^(−t/θ)     ⇒     | y(t) − y∞ | = θ · | dy/dt |
```

This identity is what makes the measurement usable, and it is why an earlier
draft's "commit when the chirp rate falls below 0.3 cents/s" was the wrong
quantity. A rate threshold does not bound the error; it bounds `error/θ`. For
this guitar, θ ≈ 1.1 s, so 0.3 cents/s happens to buy 0.33 cents — fine. On a
bass, where θ is plausibly two to three times longer, the same threshold buys
0.9 cents and consumes the entire R1 budget, with the residual glide flowing
into `|cents| + 2σ ≤ 3` as an undeclared bias. R7 would fail through the very
gap its rule exists to close.

So bound the displacement, not the rate:

- **θ is measured, not assumed.** It is the *local* log-slope of the first
  partial's **power** envelope, `θ = −1 / (d ln P₁/dt)`, which §7.2's heterodyne
  provides directly and §2.1 justifies (the excess follows amplitude squared, so
  it decays at the power rate). Taking it locally also sidesteps §9's two-stage
  decay warning entirely: no global exponential is ever fitted, so the "three
  times too fast" failure cannot occur.
- **`d = θ·|df/dt|` is a known-sign bias, and its sign must be used.** The
  reading is always *sharp* of settled by `d`; it is never flat by it. An
  earlier revision folded `d` into a symmetric σ, which is safe with respect to
  R7 and self-resolving — σ large, so the player waits, so `d` shrinks — but it
  throws away information the system has, and it has a concrete cost: §10 shows
  readings out to σ = 5, so a player tuning until the number reads zero leaves
  the string **flat by `d`, every time**. On a firm pluck that is a cent or
  more, systematic and reproducible, and it is the kind of defect that gets a
  tuner uninstalled.

  So `d` is handled as §3's third category, not the first:

  - **`d` is binding on the in-tune claim.** No in-tune claim is made while `d`
    exceeds a third of the tolerance, whatever the reading says. The "wait" hint
    below already existed; this wires it into the policy rather than leaving it
    as advice.
  - **The displayed band is asymmetric**, spanning `reading − d` to `reading`,
    which is what is actually known about where the settled pitch lies.
  - `d`'s own uncertainty, `σ_d² = (|df/dt|·σ_θ)² + (θ·σ_{df/dt})²`, contributes
    to σ in the ordinary way.

  Subtracting `d` outright and reporting `reading − d` is available and would be
  more accurate still. It is *not* the extrapolation §8 deleted — that was a
  three-parameter fit to `y∞ + A·e^(−t/θ)` extrapolated to t = ∞ from a fraction
  of one time constant, whereas this is two well-conditioned local measurements
  multiplied — but it deserves the reliability diagram's verdict before being
  trusted, so it is deferred rather than assumed.

  Folding `σ_d` into σ also supplies the timeout R2 requires: the tuner always
  commits, and σ simply stays large while the glide is large, instead of never
  committing if a chirp threshold is never crossed.
- **The sign is also useful to say out loud.** The glide is always downward, so
  when the reading is sharp and still chirping down, the honest instruction is
  "wait", not "flatten the string" — requiring no model at all.
- **Coach the pluck.** The glide amplitude is `A = θ·|df/dt|` evaluated at onset,
  so it is still measured even though the exponential fit is gone; a pluck with
  more than about 15 cents of it should prompt *"plucked hard — softer settles
  sooner"*. This teaches a habit that makes every tuner the player ever uses work
  better.

---

## 9. Amplitude envelope

Per-partial envelopes fall out of the heterodyne in §7.2 and are used in three
places: the beating detector (§7.2), the glide bound `d = θ·|df/dt|` (§8), and
the note state machine's release test (§6). Two cautions:

- A plucked string's envelope is **not one exponential**: measured on a hard low
  E, 14 dB in the first 1.5 s as the high partials die, then 17 dB over the next
  four. Any single-exponential fit to broadband level returns a decay roughly
  three times too fast. Where a decay constant is needed it must come from the
  *first partial's* envelope.
- Platform AGC, if it could not be disabled, destroys this entirely (§4).

---

## 10. Validity gates, σ, and the display decision

**Layer one — hypothesis validity.** A small, named set. Each logs when it fires,
and the reason is available to the UI and to diagnostics.

**Hard** gates refuse the reading outright; **soft** gates allow it, reduce
confidence and explain themselves. The distinction is what the display policy
below branches on.

| Gate | H/S | Fires when | Why it cannot be a variance |
|---|---|---|---|
| `clipping` | hard | sample magnitude or sustained flat-topping | fake harmonic series with a *low* residual |
| `polyphony` | hard | unexplained energy is itself harmonically organised at another period | a strum has a plausible period and a plausible B |
| `octave` | hard | comb GCD ≠ 1, or a continuity break mid-note | σ ≈ 0.2 cents while 1200 cents wrong |
| `room` | hard | fewer than two partials clear the margin | the mask itself is untrustworthy |
| `course` | soft | odd and even partials imply different f₁ beyond fit uncertainty | 12-string octave pairs fit well and wrongly |
| `beating` | soft | incoherent modulation on individual partials (§7.2) | phase slews arbitrarily fast near a beat null |
| `processing` | soft | AGC or platform filtering detected | envelope and spectrum both unreliable |
| `stale` | soft | profile older than its lifetime, invalidated, or still rebuilding after a device change | masking the wrong bands, but usable with an inflated α (§5) |

The polyphony gate deserves emphasis: §1 declares polyphony out of scope, but a
strum will otherwise pass the state machine, acquire *some* period, and return a
plausible B. It is the highest-probability confident-wrong-answer path in the
whole design, and it closes almost free. The fitted partial series predicts where
energy should be; subtract it and **run a second NSDF on the unexplained
residual**, firing only when that residual is itself harmonically organised at a
different period. The raw unexplained *fraction* is the wrong statistic, because
sympathetic ringing is always present on a guitar and is diffuse and weak, while
a second strummed note is a coherent series. This reuses §7.1 wholesale.

**Layer two — σ, within the accepted hypothesis.** σ combines exactly five
terms, and this list is authoritative:

1. per-partial phase-fit variances, corrected for correlated residuals (§7.2);
2. the f₁/B sandwich covariance evaluated at m² = 1 (§7.3);
3. admitted-bin SNR;
4. `σ_d`, the uncertainty of the glide bound (§8) — note that `d` *itself* is
   not here, because it is a known-sign bias and is handled as one;
5. χ²/dof inflation for model misfit, computed pre-robustification (§7.3).

A **floor of about 0.1–0.2 cents** applies regardless: phone sample clocks are
±20–50 ppm and some devices resample 44.1↔48 kHz inexactly, which is 0.09–0.17
cents of irreducible bias whose sign and magnitude are both unknown — the one
case where a symmetric floor is the honest treatment.

**Known-sign biases are corrected or shown, never averaged in**: the tracker's
group delay is removed by timestamping (§7.2), and the glide bound `d` is
binding on the in-tune claim and displayed as an asymmetric band (§8).

**The display policy.**

```
claim "in tune"   only if  |cents| + 2σ ≤ 3  AND  d ≤ 1     ← R7, made testable
show the reading  when     σ < 5 and no hard gate fired
show note name    when     σ ≥ 5 or a hard gate fired
show the reason   when     any gate fired
acknowledge       always, within 100 ms of the onset
```

The interval rule is the point. A policy of "σ < 1 and |cents| ≤ 3" would claim
in-tune at 2.9 cents with σ = 0.99, where the probability of truly exceeding 3
cents is about 46% — violating R7 at roughly the rate R7 forbids. The second
clause closes the other route to the same failure: a reading can be within 3
cents *now* and still be a cent sharp of where the string is going.

**σ must be visible**, or the architecture's payoff is thrown away: needle
thickness or a ghost band proportional to σ, and a written reason whenever a
reading is withheld ("too much background noise", "more than one string
ringing", "microphone processing detected").

**Display ballistics** are specified separately from σ, and must not reintroduce
the latency the acknowledgement channel below exists to avoid: a dead band
inside ±1 cent, critically damped needle motion, and hysteresis on the in-tune
claim so it does not flicker at the boundary.

**Acknowledgement is a separate channel from the reading**, and this is not a
trade-off between responsiveness and stability: the app can show that a pluck
landed within 100 ms and name the note within about 200 ms while the number takes
as long as it needs. Conflating them makes an app feel simultaneously slow and
twitchy.

**σ is an acceptance test, not an aspiration.** Against §13's ground truth, plot
predicted σ against realised |error|, binned by σ — a reliability diagram — and
require the estimator to be *conservative*. The quantile must match the
requirement it protects: R7 is a statement about the tail, k = 2 already admits a
2.3% Gaussian tail, and a σ built from residuals contaminated by outlier partials
and beat events has fatter tails than Gaussian. So require conservatism at **p99
or better**, and report **max(|error|/σ)** alongside the percentile — a single
catastrophic ratio is exactly what R7 forbids and exactly what a percentile
hides. Shipping is gated on that plot, and it will also settle the correlation
correction of §7.2 empirically.

---

## 11. Product surface the DSP implies

Not decoration; each of these changes what the DSP must accept.

1. **Reference pitch A4, 415–466 Hz.** Orchestral players need 442, early-music
   players 415.
2. **Transposition** — capo, drop-D, E♭. Not polyphony and not a sweetened
   tuning, and universally expected.
3. **Input device selection.** A USB-C or Lightning interface, or a clip-on
   piezo, appears as a media device and is the complete answer to the band-room
   case that §1 rules out of scope for acoustic capture.
4. **Microphone permission, denial and no-device states**, plus input level
   metering so a user can see the tuner is hearing them at all.
5. **"That isn't the string you selected."** With a ±200 cent acceptance window,
   playing the wrong string is silently rejected and the tuner appears dead. Detect
   a confident pitch outside the window and say so, rather than showing nothing.
6. **Note naming** — sharp/flat spelling and octave numbering, once chromatic.
7. **Profile persistence and invalidation** for both the room profile (§5) and
   the per-string B (§7.3).

---

## 12. Where I am least confident

1. **The heterodyne low-pass design, and the latency it now owns.** §7.2
   specifies a bandwidth rule and a settling time, but the filter type, length,
   decimation factor and re-centring policy are a design exercise, and R2 for
   bass now rests on them rather than on anything else in the document.
2. **Whether the gated, inverse-transformed NSDF preserves McLeod's clarity
   semantics.** §7.1 fixed a correctness bug — `m(τ)` cannot come from a gated
   spectrum — but introduced an uncharacterised one: the frame is windowed, the
   soft gain still colours the signal, and the clarity thresholds and the 90%
   peak rule were calibrated by McLeod on rectangular frames of unprocessed
   audio. The thresholds must be re-derived empirically against §13, not
   inherited.
3. **Calibrating σ.** §10 makes this an acceptance test rather than an opinion,
   but whether the combined estimate is conservative at p99 across real
   instruments and rooms is unproven, and the correlated-residual correction is
   now derived from a filter that does not yet exist.
4. **R5 — tracking duration — which nothing in the design bounds.** §5 now shows
   that a soft low-E partial at the bottom of its measured range has ~3 dB of
   headroom over the admission threshold and is masked within about a second,
   while R5 asks for four seconds. Three revisions have added partial-removing
   machinery and none checked it against this. α is now a parameter traded
   against R5 and §13 measures the duration, but the trade is unexplored and
   this may be the requirement that turns out to be unmeetable as specified.
5. **The onset threshold, which is currently absent rather than uncertain.** The
   statistic changed (log magnitude, restricted to unexplained bins) and no
   number replaced the old one; §6 says it must be derived against §13, and
   until it is, R4 cannot be implemented. This was an acknowledged unknown in an
   earlier revision that was retired by changing the statistic rather than by
   resolving it — the one place this document has gone backwards.
6. **Gate false-positive rates, which nothing currently measures.** A tuner that
   announces "more than one string ringing" on every note is worse than the
   twenty-three booleans were. §13's fixtures test that each gate fires when it
   should; the complement — a corpus of clean single plucks on which **no gate
   may fire** — is the test that matters for the user experience, and it is new.
7. **The `beating` gate's discrimination in particular.** Separating ordinary
   single-string polarisation beating from a genuine foreign partial on depth,
   rate and coherence is the right idea; the thresholds are guesses, and erring
   either way is costly — too tight and good plucks are refused, too loose and
   the phase-slew failure returns.
8. **The IRLS / χ² interaction.** §7.3 orders them so robustification cannot hide
   misfit, but a self-consistent wrong fit still produces a low χ² by
   construction, and that is the residual hole in the σ story.
9. **The polyphony threshold.** A second NSDF on the unexplained residual is a
   much better statistic than raw unexplained fraction, but how much coherent
   residual constitutes a strum — on a guitar whose sympathetic strings are
   always ringing a little — is not established.
10. **Minimum-statistics tracking on a phone microphone with unknown internal
   processing.** The method assumes a stationary noise floor beneath a
   non-stationary signal; platform AGC breaks that assumption in a way the method
   cannot see.
11. **CPU is not the risk; plumbing is.** A 4096-point FFT at 100 frames/s is
   ~15 Mflop/s and heterodyne tracking adds ~5, together low single-digit percent
   of one core. The risks are dropouts, GC pauses, SAB availability and thermal
   throttling — none of which any offline test can see.

---

## 13. Validation

No change ships without measurement against all four.

- **Synthetic sweep** — randomised plucks with known pitch, varying frequency,
  pluck strength, decay, inharmonicity, microphone roll-off, noise, and a room
  rumble at random frequency and level, deliberately wider than one instrument in
  one room. The overfitting alarm: a change that improves the real recordings and
  worsens the sweep has fitted one guitar.
- **Real recordings** — 32 takes across six strings, scored against ground truth
  from a tool sharing no code with the estimators (long windows contained wholly
  inside the note, partial-series fit; ±1 cent with a known +0.85 cent bias,
  uniform across strings and therefore cancelling in comparisons).
- **Stitched sessions** — those recordings spliced into whole sessions with
  re-plucks, string changes, silences and an appliance that stops partway, graded
  on glitches rather than accuracy: notes missed, readings invented in silence,
  wrong strings, frame-to-frame jumps. Every failure reported from real use
  appeared here and nowhere else.
- **On-device soak** — a real phone, a real room, a full tuning session with the
  screen on, instrumented for dropouts, callback jitter, CPU and thermal state.
  The three harnesses above are offline and cannot see any of §12.11.

Additions required by these revisions:

- a **reliability diagram** for σ (§10), conservative at p99, reporting
  max(|error|/σ);
- **fixtures for each categorical gate** — a clipped pluck, a strum, a 12-string
  course, a re-pluck engineered to beat, a session with a deliberately stale room
  profile — testing that each gate fires when it should;
- **tracking duration as a measured quantity** — time from onset to loss of
  reading, by string and pluck strength — scored against R5, so that α (§5) is
  tuned against evidence rather than assumed;
- a **clean-pluck corpus on which no gate may fire**, testing the complement.
  Gate *recall* is what the fixtures measure; gate *precision* is what determines
  whether the tuner is usable, and it is the easier property to lose. A design
  whose gates are individually well-motivated can still refuse most good plucks,
  which is the failure mode the prototype's twenty-three booleans actually
  exhibited.
