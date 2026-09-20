import { Engine } from './engine.js';
import { MODES, STRINGS, createEstimator } from './estimators.js';

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const TICK_MS = 40;
const IN_TUNE_CENTS = 3;
const MAX_DEFLECTION = 70;      // degrees at ±50 cents

const app = document.getElementById('app');
const noteNameEl = document.getElementById('noteName');
const noteOctaveEl = document.getElementById('noteOctave');
const centsEl = document.getElementById('centsText');
const detailEl = document.getElementById('detailText');
const needleEl = document.getElementById('needle');
const hintEl = document.getElementById('hint');
const startBtn = document.getElementById('startBtn');
const errorEl = document.getElementById('errorText');
const blurbEl = document.getElementById('modeBlurb');
const refSelect = document.getElementById('refSelect');
const modeSelect = document.getElementById('modeSelect');
const stringSelect = document.getElementById('stringSelect');

const settings = {
  reference: load('reference', 440, (v) => v >= 415 && v <= 466),
  mode: load('mode', 'studio', (v) => MODES.some((m) => m.id === v)),
  string: load('string', 'auto', (v) => STRINGS.some((s) => s.id === v)),
};

let listening = false;
let starting = false;
let audioCtx = null;
let stream = null;
let engine = null;
let estimator = null;
let wakeLock = null;
let rafId = 0;
let lastTickAt = 0;
let displayedCents = 0;
let needleAngle = 0;
let currentMidi = null;

buildTicks();
buildControls();
render(null);

startBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  if (listening) stop(); else start();
});

// Everything on the idle screen starts the tuner, so there is nothing to aim at.
app.addEventListener('click', (event) => {
  if (listening || starting) return;
  if (event.target.closest('select, label, button')) return;
  start();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listening) {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    requestWakeLock();
  }
});

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
    stop();   // autostart without a user gesture: the browser wants a tap first
    return;
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const highpass = audioCtx.createBiquadFilter();   // drop handling rumble / DC
  highpass.type = 'highpass';
  highpass.frequency.value = 25;
  const lowpass = audioCtx.createBiquadFilter();    // drop hiss above anything musical
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 3500;

  engine = new Engine(audioCtx.sampleRate);
  buildEstimator();

  const sink = await createCaptureNode(audioCtx, (block) => engine.push(block));
  source.connect(highpass).connect(lowpass).connect(sink);

  // A capture node is only pulled if it reaches the destination; muting keeps
  // the microphone out of the speakers.
  const mute = audioCtx.createGain();
  mute.gain.value = 0;
  sink.connect(mute).connect(audioCtx.destination);

  listening = true;
  app.classList.remove('state-idle', 'state-error');
  app.classList.add('state-listening');
  startBtn.textContent = 'Stop';
  startBtn.classList.add('ghost');
  requestWakeLock();
  loop(performance.now());
}

/** AudioWorklet where available, ScriptProcessor as a fallback. */
async function createCaptureNode(context, onBlock) {
  if (context.audioWorklet) {
    try {
      await context.audioWorklet.addModule('./capture-worklet.js');
      const node = new AudioWorkletNode(context, 'capture');
      node.port.onmessage = (event) => onBlock(event.data);
      return node;
    } catch { /* fall through */ }
  }
  const node = context.createScriptProcessor(1024, 1, 1);
  node.onaudioprocess = (event) => onBlock(event.inputBuffer.getChannelData(0));
  return node;
}

function stop() {
  listening = false;
  cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  stream = null;
  audioCtx = null;
  engine = null;
  estimator = null;
  releaseWakeLock();

  app.classList.remove('state-listening', 'has-note', 'in-tune', 'flat', 'sharp', 'stale', 'settling', 'provisional');
  app.classList.add('state-idle');
  startBtn.textContent = 'Start tuning';
  startBtn.classList.remove('ghost');
  currentMidi = null;
  render(null);
  needleAngle = 0;
  displayedCents = 0;
  needleEl.style.transform = 'rotate(0deg)';
}

async function tryAutoStart() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    if (status.state === 'granted') start();
  } catch {
    /* Permissions API is unavailable (Safari) — the user taps to start. */
  }
}

function fail(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  app.classList.add('state-error');
}

/* ------------------------------------------------------------- estimation */

function buildEstimator() {
  if (!engine) return;
  estimator = createEstimator(settings.mode, {
    sampleRate: engine.sampleRate,
    engine,
    targetHz,
  });
  currentMidi = null;
}

function targetHz() {
  const string = STRINGS.find((s) => s.id === settings.string);
  if (!string || string.midi === null) return null;
  return settings.reference * Math.pow(2, (string.midi - 69) / 12);
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  if (now - lastTickAt >= TICK_MS && document.visibilityState === 'visible') {
    lastTickAt = now;
    const frame = engine.analyse();
    render(estimator.update(frame));
  }
  animateNeedle();
}

function render(reading) {
  const status = reading ? reading.status : 'idle';
  app.classList.toggle('settling', status === 'settling');
  if (!reading || status === 'idle') app.classList.remove('provisional');

  if (!reading || !reading.frequency || status === 'idle') {
    noteNameEl.textContent = '';
    noteOctaveEl.textContent = '';
    centsEl.textContent = '';
    detailEl.textContent = '';
    app.classList.remove('has-note', 'in-tune', 'flat', 'sharp', 'stale');
    hintEl.textContent = listening ? listeningHint() : '';
    return;
  }

  const target = targetHz();
  const string = STRINGS.find((s) => s.id === settings.string);
  let midi;
  let cents;
  if (target) {
    // Locked to a string: stay on that note however far out of tune it is.
    midi = string.midi;
    cents = 1200 * Math.log2(reading.frequency / target);
  } else {
    const semitones = 12 * Math.log2(reading.frequency / settings.reference);
    midi = Math.round(semitones) + 69;
    cents = (semitones - Math.round(semitones)) * 100;
  }

  if (midi !== currentMidi) {
    currentMidi = midi;
    displayedCents = cents;
  } else {
    displayedCents += (cents - displayedCents) * 0.35;
  }

  const rounded = Math.round(displayedCents);
  const inTune = Math.abs(rounded) <= IN_TUNE_CENTS;
  const settling = status === 'settling';
  // A reading the mode itself does not yet trust is shown, but never as a
  // confident "in tune" — that is the part of v1 that misled you.
  const provisional = status === 'live' && reading.settled === false;

  noteNameEl.textContent = NOTE_NAMES[((midi % 12) + 12) % 12];
  noteOctaveEl.textContent = Math.floor(midi / 12) - 1;
  centsEl.textContent = settling
    ? 'listening…'
    : inTune ? 'In tune' : `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} cents`;
  detailEl.textContent = [
    `${reading.frequency.toFixed(1)} Hz`,
    reading.detail,
  ].filter(Boolean).join(' · ');
  hintEl.textContent = settling ? 'holding the pluck…' : provisional ? 'settling…' : '';

  app.classList.add('has-note');
  app.classList.toggle('provisional', provisional);
  app.classList.toggle('stale', status === 'held');
  app.classList.toggle('in-tune', inTune && !settling && !provisional);
  app.classList.toggle('flat', !inTune && !settling && rounded < 0);
  app.classList.toggle('sharp', !inTune && !settling && rounded > 0);
}

function listeningHint() {
  const string = STRINGS.find((s) => s.id === settings.string);
  return string && string.midi !== null
    ? `Play the ${string.label.split(' · ')[0]} string`
    : 'Play a single note';
}

function animateNeedle() {
  const target = (clamp(displayedCents, -50, 50) / 50) * MAX_DEFLECTION;
  needleAngle += (target - needleAngle) * 0.22;
  needleEl.style.transform = `rotate(${needleAngle.toFixed(2)}deg)`;
}

/* -------------------------------------------------------------- controls */

function buildControls() {
  for (let hz = 415; hz <= 466; hz++) {
    refSelect.append(new Option(`${hz} Hz`, String(hz), false, hz === settings.reference));
  }
  for (const mode of MODES) {
    modeSelect.append(new Option(mode.label, mode.id, false, mode.id === settings.mode));
  }
  for (const string of STRINGS) {
    stringSelect.append(new Option(string.label, string.id, false, string.id === settings.string));
  }
  showBlurb();

  refSelect.addEventListener('change', () => {
    settings.reference = Number(refSelect.value);
    save('reference', settings.reference);
    buildEstimator();
  });
  modeSelect.addEventListener('change', () => {
    settings.mode = modeSelect.value;
    save('mode', settings.mode);
    showBlurb();
    buildEstimator();
  });
  stringSelect.addEventListener('change', () => {
    settings.string = stringSelect.value;
    save('string', settings.string);
    buildEstimator();
    render(null);
  });
}

function showBlurb() {
  const mode = MODES.find((m) => m.id === settings.mode);
  blurbEl.textContent = mode ? mode.blurb : '';
}

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

/* ----------------------------------------------------------------- utils */

function load(key, fallback, isValid) {
  try {
    const raw = localStorage.getItem(`tunedup.${key}`);
    if (raw === null) return fallback;
    const value = typeof fallback === 'number' ? Number(raw) : raw;
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try { localStorage.setItem(`tunedup.${key}`, String(value)); } catch { /* private mode */ }
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
