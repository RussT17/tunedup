# What's left

Measured state is in [DESIGN.md §14](DESIGN.md); this is what would be worth
doing next, in the order I'd do it.

## Known gaps, largest first

1. **A softly plucked low E goes quiet after about a second** (R5 asks for
   four). Every attempt to extend it by loosening admission brought back wrong
   readings. The honest fix is probably not in the mask at all — it is to keep
   tracking a partial whose *phase* is still coherent even after its magnitude
   has sunk into the room, which the heterodyne can in principle do and the
   current admission logic forbids.

2. **A strum still gets a confident answer.** The polyphony gate specified in
   DESIGN §10 — a second NSDF on the unexplained residual — was never built.
   What stands in for it today only catches a note that was *already* sounding
   when the new one started. This is the highest-probability route to a
   confident wrong answer in the system.

3. **Nothing has run on a phone.** No offline harness and no desktop browser
   can see dropouts, GC pauses, thermal throttling, or what a phone's own
   audio processing does to the amplitude envelope the glide correction
   depends on. DESIGN §12.12 is right that this is the real risk.

4. **The `beating` gate's thresholds are guesses.** It fires on 388 of 2828
   frames. Some of that is correct — sympathetic ringing is real — but nothing
   establishes the rate at which it *should* fire.

## Worth doing, not urgent

- **Bass.** The design covers it (12288-point window, tighter filter
  stopband, mains exclusion mattering much more) and none of it is implemented.
  `MIN_F0` is 60 Hz today.
- **Transposition and capo**, which the design calls universally expected.
- **Input device selection** — a clip-on piezo or USB interface is the complete
  answer to the band-room case the design rules out for acoustic capture.
- **"That isn't the string you meant."** With auto-detection there is no
  selected string to be wrong about yet, but once there is, silently rejecting
  a note outside the window makes the tuner look dead.
- **Cache the per-string inharmonicity across sessions.** It is cached in
  memory and thrown away on reload; it is a property of the string, not the
  pluck, and it is what lets a two-partial reading still be worth showing.

## Deliberately not doing

- **Predicting the settled pitch.** Deleted in DESIGN §8 and it should stay
  deleted: unnecessary where it works, and it fails exactly where it would pay.
- **Chasing the last of the `e4` disagreement with the reference recordings.**
  Two independent measurements disagree by ~3.5 cents on that string and the
  reference's own spread there is 2.8 cents. The synthetic sweep, whose pitch
  is exact, shows no bias. The ruler is the suspect, not the tuner, and a
  better ruler is a bigger job than it is worth.
