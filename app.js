import { PitchDetector } from './pitch.js';

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const WINDOW_SIZE = 8192;       // ~170 ms at 48 kHz — enough for low bass notes
const DETECT_INTERVAL = 40;     // ms between analyses
const IN_TUNE_CENTS = 3;
const HOLD_MS = 900;            // keep showing the last note this long after it fades
const MAX_DEFLECTION = 70;      // degrees at ±50 cents

const app = document.getElementById('app');
const noteNameEl = document.getElementById('noteName');
const noteOctaveEl = document.getElementById('noteOctave');
const centsEl = document.getElementById('centsText');
const freqEl = document.getElementById('freqText');
const needleEl = document.getElementById('needle');
const hintEl = document.getElementById('hint');
const startBtn = document.getElementById('startBtn');
const errorEl = document.getElementById('errorText');
const refBtn = document.getElementById('refBtn');
const refValueEl = document.getElementById('refValue');
const refSheet = document.getElementById('refSheet');
const refBigEl = document.getElementById('refBig');

let referenceHz = clampRef(Number(localStorage.getItem('tunedup.reference')) || 440);
let listening = false;
let starting = false;   // getUserMedia is async — don't let a double tap open two streams
let audioCtx = null;
let stream = null;
let analyser = null;
let detector = null;
let sampleBuffer = null;
let wakeLock = null;
let rafId = 0;
let lastDetectAt = 0;
let lastGoodAt = 0;
let history = [];               // recent accepted readings
let displayedCents = 0;         // smoothed value behind the needle
let needleAngle = 0;            // animated angle, degrees
let currentMidi = null;

buildTicks();
render(null);
setReference(referenceHz);

startBtn.addEventListener('click', () => (listening ? stop() : start()));
refBtn.addEventListener('click', () => { refBigEl.textContent = referenceHz; refSheet.hidden = false; });
document.getElementById('refDone').addEventListener('click', () => { refSheet.hidden = true; });
refSheet.addEventListener('click', (e) => { if (e.target === refSheet) refSheet.hidden = true; });
document.getElementById('refDown').addEventListener('click', () => nudgeReference(-1));
document.getElementById('refUp').addEventListener('click', () => nudgeReference(1));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listening) {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    requestWakeLock();
  }
});

// If the mic was already granted on a previous visit, skip the tap entirely.
tryAutoStart();

/* ------------------------------------------------------------------ audio */

async function start() {
  if (listening || starting) return;
  starting = true;
  try {
    await openMicrophone();
  } finally {
    starting = false;
  }
}

async function openMicrophone() {
  errorEl.hidden = true;

  if (!window.isSecureContext) {
    return fail('Microphone access needs a secure connection. Open TunedUp over https.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return fail('This browser will not give TunedUp a microphone. Try Safari or Chrome.');
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return fail('Microphone blocked. Allow mic access for this site, then tap Start again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return fail('No microphone found. Connect one and tap Start again.');
    }
    return fail('Could not open the microphone. Check that nothing else is using it.');
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try { await audioCtx.resume(); } catch { /* handled below */ }
  if (audioCtx.state !== 'running') {
    // Autostart without a user gesture: the browser wants a tap first.
    stop();
    return;
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const highpass = audioCtx.createBiquadFilter();   // drop handling rumble / DC
  highpass.type = 'highpass';
  highpass.frequency.value = 25;
  const lowpass = audioCtx.createBiquadFilter();    // drop hiss above anything musical
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 3500;

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = WINDOW_SIZE;
  analyser.smoothingTimeConstant = 0;

  source.connect(highpass).connect(lowpass).connect(analyser);

  detector = new PitchDetector(WINDOW_SIZE);
  sampleBuffer = new Float32Array(WINDOW_SIZE);
  history = [];
  currentMidi = null;

  listening = true;
  app.classList.remove('state-idle', 'state-error');
  app.classList.add('state-listening');
  startBtn.textContent = 'Stop';
  startBtn.classList.add('ghost');
  hintEl.textContent = 'Play a single note';
  centsEl.textContent = 'Listening…';
  requestWakeLock();
  loop(performance.now());
}

function stop() {
  listening = false;
  cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  stream = null;
  audioCtx = null;
  analyser = null;
  releaseWakeLock();

  app.classList.remove('state-listening', 'has-note', 'in-tune', 'flat', 'sharp', 'stale');
  app.classList.add('state-idle');
  startBtn.textContent = 'Start tuning';
  startBtn.classList.remove('ghost');
  currentMidi = null;
  history = [];
  render(null);
  centsEl.textContent = 'Tap to start';
  needleAngle = 0;
  displayedCents = 0;
  needleEl.style.transform = 'rotate(0deg)';
}


async function tryAutoStart() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    if (status.state === 'granted') start();
  } catch {
    /* Permissions API is unavailable (Safari) — the user taps Start. */
  }
}

function fail(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  app.classList.add('state-error');
  centsEl.textContent = '';
}

/* ------------------------------------------------------------- detection */

function loop(now) {
  rafId = requestAnimationFrame(loop);

  if (now - lastDetectAt >= DETECT_INTERVAL && document.visibilityState === 'visible') {
    lastDetectAt = now;
    analyser.getFloatTimeDomainData(sampleBuffer);
    const { frequency, clarity } = detector.detect(sampleBuffer, audioCtx.sampleRate);
    if (frequency > 0 && clarity > 0.7) {
      history.push({ t: now, frequency });
      lastGoodAt = now;
    }
    while (history.length && now - history[0].t > 220) history.shift();

    if (history.length >= 2) {
      render(median(history.map((h) => h.frequency)));
    } else if (now - lastGoodAt > HOLD_MS) {
      app.classList.add('stale');
      if (!app.classList.contains('has-note')) centsEl.textContent = 'Listening…';
    }
  }

  animateNeedle();
}

function render(frequency) {
  if (!frequency) {
    noteNameEl.textContent = '';
    noteOctaveEl.textContent = '';
    freqEl.textContent = '';
    app.classList.remove('has-note', 'in-tune', 'flat', 'sharp', 'stale');
    return;
  }

  const semitones = 12 * Math.log2(frequency / referenceHz);
  const midi = Math.round(semitones) + 69;
  const cents = (semitones - Math.round(semitones)) * 100;

  // Snapping to a new note should feel instant; drift within a note is smoothed.
  if (midi !== currentMidi) {
    currentMidi = midi;
    displayedCents = cents;
  } else {
    displayedCents += (cents - displayedCents) * 0.35;
  }

  const rounded = Math.round(displayedCents);
  const inTune = Math.abs(rounded) <= IN_TUNE_CENTS;

  noteNameEl.textContent = NOTE_NAMES[((midi % 12) + 12) % 12];
  noteOctaveEl.textContent = Math.floor(midi / 12) - 1;
  centsEl.textContent = inTune ? 'In tune' : `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} cents`;
  freqEl.textContent = `${frequency.toFixed(1)} Hz`;

  app.classList.add('has-note');
  app.classList.remove('stale');
  app.classList.toggle('in-tune', inTune);
  app.classList.toggle('flat', !inTune && rounded < 0);
  app.classList.toggle('sharp', !inTune && rounded > 0);
}

function animateNeedle() {
  const target = (clamp(displayedCents, -50, 50) / 50) * MAX_DEFLECTION;
  needleAngle += (target - needleAngle) * 0.22;
  needleEl.style.transform = `rotate(${needleAngle.toFixed(2)}deg)`;
}

/* ----------------------------------------------------------------- gauge */

function buildTicks() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const group = document.getElementById('ticks');
  const cx = 150, cy = 150;

  for (let c = -50; c <= 50; c += 5) {
    const major = c % 25 === 0;
    const angle = ((c / 50) * MAX_DEFLECTION - 90) * (Math.PI / 180);
    const outer = 112, inner = major ? 98 : 105;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', cx + Math.cos(angle) * inner);
    line.setAttribute('y1', cy + Math.sin(angle) * inner);
    line.setAttribute('x2', cx + Math.cos(angle) * outer);
    line.setAttribute('y2', cy + Math.sin(angle) * outer);
    line.setAttribute('class', `tick${major ? ' major' : ''}${c === 0 ? ' center' : ''}`);
    group.appendChild(line);
  }

  for (const [c, label] of [[-50, '♭'], [50, '♯']]) {
    const angle = ((c / 50) * MAX_DEFLECTION - 90) * (Math.PI / 180);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', cx + Math.cos(angle) * 132);
    text.setAttribute('y', cy + Math.sin(angle) * 132 + 6);
    text.setAttribute('class', 'tick-label');
    text.textContent = label;
    group.appendChild(text);
  }
}

/* ------------------------------------------------------------- reference */

function nudgeReference(delta) {
  setReference(referenceHz + delta);
  refBigEl.textContent = referenceHz;
  currentMidi = null;
}

function setReference(hz) {
  referenceHz = clampRef(hz);
  refValueEl.textContent = referenceHz;
  localStorage.setItem('tunedup.reference', String(referenceHz));
}

function clampRef(hz) {
  return clamp(Math.round(hz) || 440, 415, 466);
}

/* ----------------------------------------------------------------- utils */

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* screen may just dim — not worth surfacing */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

/* ------------------------------------------------------------------- pwa */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
