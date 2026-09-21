// Note naming and cents. Chromatic, with guitar string names layered on top.

export const A4 = 440;
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// Guitar range with headroom: low E2 down a whole tone (drop-D and then some)
// up to the 12th fret of the high E.
export const MIN_F0 = 60;
export const MAX_F0 = 700;

export function freqToMidi(f, a4 = A4) {
  return 69 + 12 * Math.log2(f / a4);
}

export function midiToFreq(m, a4 = A4) {
  return a4 * Math.pow(2, (m - 69) / 12);
}

export function cents(f, ref) {
  return 1200 * Math.log2(f / ref);
}

// Nearest chromatic note to f, and how far off it is.
export function nearestNote(f, a4 = A4) {
  const midi = Math.round(freqToMidi(f, a4));
  const ref = midiToFreq(midi, a4);
  return {
    midi,
    name: NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    ref,
    cents: cents(f, ref),
  };
}

// Standard tuning, for the location prior of DESIGN §7.2 and for the
// "that isn't the string you selected" case of §11.5.
export const STANDARD_TUNING = [
  { name: 'E', octave: 2, midi: 40 },
  { name: 'A', octave: 2, midi: 45 },
  { name: 'D', octave: 3, midi: 50 },
  { name: 'G', octave: 3, midi: 55 },
  { name: 'B', octave: 3, midi: 59 },
  { name: 'E', octave: 4, midi: 64 },
];
