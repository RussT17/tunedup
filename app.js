import { Engine } from './engine.js';
import { MODES, STRINGS, createEstimator } from './estimators.js';
import { renderTrace } from './trace.js';

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const TICK_MS = 40;
const RECORD_SECONDS = 15;
const RECORD_PREROLL = 0.5;     // a moment before the tap, in case it came late
const IN_TUNE_CENTS = 3;
// A pluck this sharp at the attack has a glide that takes seconds to finish.
// The reading is worth less and the honest thing is to say so rather than to
// keep fitting the hard case.
const HARD_PLUCK_CENTS = 15;
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
const arcProgressEl = document.getElementById('arcProgress');
const strikeEl = document.getElementById('strike');
const tracePanel = document.getElementById('tracePanel');
const traceChart = document.getElementById('traceChart');
const traceStats = document.getElementById('traceStats');
const traceReadout = document.getElementById('traceReadout');
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
let acknowledgedOnset = -1;
let shownConfidence = 0;
let wasConfidentlyInTune = false;

// Per-note trace: every frame of the current pluck, kept so it can be plotted.
let trace = null;
let lastTrace = null;
let traceScales = null;
let traceOpen = false;
let recording = null;

buildTicks();
buildControls();
render(null);

document.getElementById('traceBtn').addEventListener('click', (event) => {
  event.stopPropagation();
  traceOpen = true;
  tracePanel.hidden = false;
  drawTrace();
});
document.getElementById('traceClose').addEventListener('click', () => {
  traceOpen = false;
  tracePanel.hidden = true;
});
document.getElementById('saveBtn').addEventListener('click', toggleRecording);
traceChart.addEventListener('pointermove', onTracePointer);
traceChart.addEventListener('pointerdown', onTracePointer);
traceChart.addEventListener('pointerleave', () => { traceReadout.textContent = ''; });

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

  engine = new Engine(audioCtx.sampleRate);
  buildEstimator();

  // Unfiltered into the engine: it does its own filtering, so a replay of an
  // exported recording behaves exactly as the app did.
  const sink = await createCaptureNode(audioCtx, (block) => engine.push(block));
  source.connect(sink);

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

  app.classList.remove('state-listening', 'has-note', 'in-tune', 'flat', 'sharp', 'stale', 'settling', 'provisional', 'confident');
  acknowledgedOnset = -1;
  shownConfidence = 0;
  app.classList.add('state-idle');
  startBtn.textContent = 'Start tuning';
  startBtn.classList.remove('ghost');
  currentMidi = null;
  trace = null;
  recording = null;
  showRecordState();
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
  engine.setTarget(targetHz());
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
    const reading = estimator.update(frame);
    acknowledge(frame);
    recordTrace(frame, reading);
    render(reading, frame);
    pollRecording();
    if (traceOpen) drawTrace();
  }
  animateNeedle();
}

/**
 * The moment a pluck lands, before anything is known about its pitch. Keeping
 * this separate from the reading is what lets the app feel immediate and still
 * take its time about the number — they are different channels, not a
 * trade-off between responsiveness and stability.
 */
function acknowledge(frame) {
  if (frame.onsetAge === null || frame.onsetId === acknowledgedOnset) return;
  acknowledgedOnset = frame.onsetId;
  wasConfidentlyInTune = false;
  shownConfidence = 0;
  if (strikeEl.animate) {
    strikeEl.animate(
      [
        { opacity: 0.55, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(8)' },
      ],
      { duration: 520, easing: 'cubic-bezier(.22,.61,.36,1)' }
    );
  }
}

function render(reading, frame) {
  const status = reading ? reading.status : 'idle';
  app.classList.toggle('settling', status === 'settling');
  if (!reading || status === 'idle') app.classList.remove('provisional');

  // Name the note the moment the detector knows it, which is a few hundred
  // milliseconds before any reading is worth showing. Recognising the string
  // is the acknowledgement the player wants; the cents can follow.
  const namedEarly = status === 'settling' && frame && frame.f0 && frame.clarity > 0.7;
  if (namedEarly) showNoteName(noteFor(frame.f0));

  if (!reading || !reading.frequency || status === 'idle') {
    if (!namedEarly) {
      noteNameEl.textContent = '';
      noteOctaveEl.textContent = '';
    }
    centsEl.textContent = namedEarly ? 'listening…' : '';
    detailEl.textContent = '';
    app.classList.remove('in-tune', 'flat', 'sharp', 'stale', 'confident');
    app.classList.toggle('has-note', namedEarly);
    arcProgressEl.style.strokeDasharray = '0 100';
    hintEl.textContent = listening && !namedEarly ? listeningHint() : '';
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

  showNoteName(midi);
  // "In tune" is a claim. It is only made once the reading has earned it —
  // before that the player gets the number, which informs without asserting.
  // The claim is withheld until the dial has filled, whatever the mode. Modes
  // that report the instantaneous pitch are not wrong, but a string that is
  // still gliding is not in tune yet and should not be told it is.
  const mayClaim = !provisional && shownConfidence > 0.9;
  centsEl.textContent = settling
    ? 'listening…'
    : inTune && mayClaim
      ? 'In tune'
      : `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} cents`;
  detailEl.textContent = [
    `${reading.frequency.toFixed(1)} Hz`,
    reading.detail,
  ].filter(Boolean).join(' · ');
  hintEl.textContent = settling
    ? 'holding the pluck…'
    : provisional
      ? 'settling…'
      : reading.glide > HARD_PLUCK_CENTS
        ? 'plucked hard — softer settles sooner'
        : '';

  // How settled the reading is, shown as the dial filling rather than as a
  // number that changes under the user.
  // Only ever forwards within a note. The underlying trust dips when the fit
  // re-evaluates, and an indicator that slides backwards is precisely the
  // fidgeting this is meant to replace — evidence accumulates, so the dial
  // does too, and it resets when a new note is struck.
  const confidence = typeof reading.confidence === 'number' ? reading.confidence : 1;
  shownConfidence = Math.max(shownConfidence, confidence);
  arcProgressEl.style.strokeDasharray = `${(shownConfidence * 100).toFixed(1)} 100`;
  app.classList.toggle('confident', shownConfidence >= 0.999 && status !== 'settling');

  app.classList.add('has-note');
  app.classList.toggle('provisional', provisional);
  app.classList.toggle('stale', status === 'held');
  app.classList.toggle('in-tune', inTune && !settling && mayClaim);
  app.classList.toggle('flat', !inTune && !settling && rounded < 0);
  app.classList.toggle('sharp', !inTune && !settling && rounded > 0);

  // One quiet confirmation the first time a string arrives, rather than a
  // colour that was already green flickering on and off.
  const confidentlyInTune = inTune && !settling && mayClaim;
  if (confidentlyInTune && !wasConfidentlyInTune && noteNameEl.animate) {
    noteNameEl.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
      { duration: 420, easing: 'cubic-bezier(.22,.61,.36,1)' }
    );
  }
  wasConfidentlyInTune = confidentlyInTune;
}

function showNoteName(midi) {
  if (midi === null) return;
  noteNameEl.textContent = NOTE_NAMES[((midi % 12) + 12) % 12];
  noteOctaveEl.textContent = Math.floor(midi / 12) - 1;
}

/** Nearest note to a raw frequency, honouring a chosen string. */
function noteFor(frequency) {
  const string = STRINGS.find((s) => s.id === settings.string);
  if (string && string.midi !== null) return string.midi;
  if (!frequency) return null;
  return Math.round(12 * Math.log2(frequency / settings.reference)) + 69;
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

/* ------------------------------------------------------------------ trace */

function recordTrace(frame, reading) {
  if (frame.onsetAge === null) return;
  if (!trace || trace.onsetId !== frame.onsetId) {
    if (trace && trace.points.length > 4) lastTrace = trace;
    trace = { onsetId: frame.onsetId, points: [], startedAt: frame.time };
  }
  trace.points.push({
    t: frame.onsetAge,
    abs: frame.time,
    raw: frame.f0,
    clarity: frame.clarity,
    rms: frame.rms,
    reported: reading.frequency,
    status: reading.status,
  });
  if (trace.points.length > 600) trace.points.shift();
  trace.mode = MODES.find((m) => m.id === settings.mode)?.label ?? settings.mode;
  trace.fit = estimator.fitInfo();
  trace.noteHz = traceReference(trace);
}

/** Cents are measured against the note the pluck belongs to. */
function traceReference(current) {
  const target = targetHz();
  if (target) return target;
  const last = [...current.points].reverse().find((p) => p.reported);
  if (!last) return null;
  const semitones = Math.round(12 * Math.log2(last.reported / settings.reference));
  return settings.reference * Math.pow(2, semitones / 12);
}

function drawTrace() {
  const current = (trace && trace.points.length > 3) ? trace : lastTrace;
  if (!current) {
    traceChart.innerHTML = renderTrace({ points: [], noteHz: null }).svg;
    traceStats.innerHTML = '';
    traceScales = null;
    return;
  }

  const fit = current.fit && current.points.length
    ? { ...current.fit, originT: current.fit.origin - current.points[0].abs + current.points[0].t }
    : null;
  const { svg, scales } = renderTrace({ ...current, fit });
  traceChart.innerHTML = svg;
  traceScales = scales ? { ...scales, points: current.points } : null;

  const midi = Math.round(12 * Math.log2(current.noteHz / settings.reference)) + 69;
  const rows = [
    ['Note', `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1} · ${current.noteHz.toFixed(2)} Hz`],
    ['Mode', current.mode],
    ['Length', `${current.points[current.points.length - 1].t.toFixed(1)} s`],
  ];
  if (fit) {
    rows.push(['Pluck glide', `${fit.amplitude >= 0 ? '+' : ''}${fit.amplitude.toFixed(1)} cents`]);
    rows.push(['Decay τ', `${fit.theta.toFixed(2)} s`]);
    rows.push(['Fit confidence', `${Math.round(fit.trust * 100)}%`]);
    if (fit.partial) rows.push(['Partial tracked', `${fit.partial} · B = ${fit.B.toExponential(1)}`]);
  }
  traceStats.innerHTML = rows
    .map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`)
    .join('');
}

function onTracePointer(event) {
  if (!traceScales) return;
  const box = traceChart.getBoundingClientRect();
  const t = ((event.clientX - box.left) / box.width) * 360;
  const seconds = traceScales.duration * ((t - 40) / (350 - 40));
  let nearest = null;
  for (const p of traceScales.points) {
    if (!nearest || Math.abs(p.t - seconds) < Math.abs(nearest.t - seconds)) nearest = p;
  }
  if (!nearest) return;
  const value = nearest.reported || nearest.raw;
  traceReadout.textContent = value
    ? `${nearest.t.toFixed(2)} s · ${(1200 * Math.log2(value / traceScales.noteHz)).toFixed(1)} cents · ${value.toFixed(2)} Hz`
    : `${nearest.t.toFixed(2)} s · no pitch`;
}

async function toggleRecording() {
  if (recording) {          // tapping again cancels
    recording = null;
    showRecordState();
    return;
  }
  if (!listening) {
    await start();
    if (!listening) return; // mic refused — the error message says why
  }
  if (!engine) return;
  recording = {
    from: Math.max(0, engine.taped - Math.round(RECORD_PREROLL * engine.sampleRate)),
    to: engine.taped + Math.round(RECORD_SECONDS * engine.sampleRate),
  };
  showRecordState();
}

/** Driven by captured samples rather than the clock, so the bar tracks the audio. */
function pollRecording() {
  if (!recording || !engine) return;
  if (engine.taped >= recording.to) {
    const { from, to } = recording;
    recording = null;
    saveRecording(engine.tapeSlice(from, to));
  }
  showRecordState();
}

function showRecordState() {
  const button = document.getElementById('saveBtn');
  const bar = document.getElementById('recordBar');
  const fill = document.getElementById('recordFill');

  if (!recording || !engine) {
    button.textContent = `Record ${RECORD_SECONDS} s`;
    button.classList.remove('armed');
    bar.hidden = true;
    fill.style.width = '0%';
    return;
  }
  const total = recording.to - recording.from;
  const done = Math.min(total, Math.max(0, engine.taped - recording.from));
  const left = Math.max(0, (recording.to - engine.taped) / engine.sampleRate);
  button.textContent = `Recording — ${Math.ceil(left)} s`;
  button.classList.add('armed');
  bar.hidden = false;
  fill.style.width = `${((done / total) * 100).toFixed(1)}%`;
}

function saveRecording(samples) {
  const blob = new Blob([encodeWav(samples, engine.sampleRate)], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
  const string = STRINGS.find((s) => s.id === settings.string);
  link.download = `tunedup-${string && string.midi !== null ? string.id : 'note'}-${stamp}.wav`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  const note = document.getElementById('panelNote');
  note.textContent = `Saved ${link.download}`;
  clearTimeout(saveRecording.timer);
  saveRecording.timer = setTimeout(() => {
    note.textContent = 'Tap, play, and it downloads itself when the 15 seconds are up.';
  }, 6000);
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, string) => {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return buffer;
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
