// TunedUp: the UI.
//
// Two screens. Holding the start button IS the room measurement -- one
// control, no separate calibration step, and the two seconds you wait are two
// seconds the tuner spends learning what your room sounds like. The same
// control stays available while tuning, because rooms change: an appliance
// starts, or stops.
//
// The display obeys DESIGN §10. Three things it will not do:
//   * show a number it does not believe (sigma >= 5, or a hard gate);
//   * claim "in tune" unless |cents| + 2 sigma <= 3 AND the glide bound is
//     small -- the interval rule, not a separate threshold on each;
//   * make you wait for the number to know you played something. The
//     acknowledgement is a separate channel and arrives inside 100 ms.

const HOLD_MS = 2000;

const el = (id) => document.getElementById(id);
const ui = {
  start: el('start'), tuner: el('tuner'),
  hold: el('hold'), fill: el('hold-fill'), holdLabel: el('hold-label'),
  hint: el('hold-hint'), startError: el('start-error'),
  note: el('note'), octave: el('octave'), meter: el('meter'),
  needle: el('needle'), band: el('band'),
  cents: el('cents'), direction: el('direction'), status: el('status'),
  recalibrate: el('recalibrate'), ref: el('ref'), refValue: el('ref-value'),
};

// Ticks every ten cents.
{
  const ticks = el('ticks');
  for (let c = -50; c <= 50; c += 10) {
    const i = document.createElement('i');
    i.style.left = `${50 + c}%`;
    if (c % 25 === 0) i.className = 'major';
    ticks.appendChild(i);
  }
}

const GATE_TEXT = {
  clipping: 'Too loud — move the phone back',
  polyphony: 'More than one note ringing',
  octave: 'Working out which note that is…',
  room: 'Too much background noise to tune here',
  course: 'Two strings sounding together',
  beating: 'Another string is ringing along',
  processing: 'Your phone is processing the audio',
  stale: 'The room got louder — try re-reading it',
};

let audio = null;
let worker = null;
let node = null;
let stream = null;
let running = false;
let a4 = Number(localStorage.getItem('tunedup.a4')) || 440;
let lastHeard = 0;
let calibrating = null;   // { resolve, mode }

ui.refValue.textContent = a4;

// ---- starting up ---------------------------------------------------------

async function ensureAudio() {
  if (audio) return;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // AGC in particular destroys the amplitude envelope the glide
      // correction depends on. These are requests, not guarantees.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  audio = new (window.AudioContext || window.webkitAudioContext)();
  await audio.resume();
  await audio.audioWorklet.addModule('src/capture-worklet.js');

  worker = new Worker('src/worker.js', { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.postMessage({ type: 'init', sampleRate: audio.sampleRate, a4 });

  const source = audio.createMediaStreamSource(stream);
  node = new AudioWorkletNode(audio, 'capture');
  node.port.onmessage = (e) => worker.postMessage({ type: 'audio', buffer: e.data }, [e.data]);
  source.connect(node);
  // Keep the graph pulling without making any sound.
  const sink = audio.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(audio.destination);

  // A device or route change puts a gap in the phase record, which is fatal to
  // the tracker. Tell the engine so it can drop everything that assumed
  // continuity, rather than reporting garbage after a headphone is unplugged.
  navigator.mediaDevices.addEventListener?.('devicechange', () => {
    worker?.postMessage({ type: 'discontinuity' });
  });
}

function onWorkerMessage(event) {
  const msg = event.data;
  if (msg.type === 'result') render(msg.result, msg);
  else if (msg.type === 'calibrated') finishCalibration(msg.ok);
}

// ---- hold to calibrate ---------------------------------------------------

function wireHold(button, onComplete, { label } = {}) {
  let raf = 0, startedAt = 0, active = false;

  const begin = async (event) => {
    event.preventDefault();
    if (active || running === 'starting') return;
    active = true;
    button.classList.add('holding');
    try {
      await ensureAudio();
    } catch (err) {
      active = false;
      button.classList.remove('holding');
      showStartError(err);
      return;
    }
    worker.postMessage({ type: 'calibrate-begin' });
    startedAt = performance.now();
    tick();
  };

  const tick = () => {
    const held = performance.now() - startedAt;
    const p = Math.min(1, held / HOLD_MS);
    ui.fill && button === ui.hold && (ui.fill.style.transform = `scaleY(${p})`);
    if (label) button.textContent = p < 1 ? `Listening… ${(HOLD_MS - held) / 1000 > 0 ? Math.ceil((HOLD_MS - held) / 1000) : 0}` : label;
    if (p >= 1) { active = false; button.classList.remove('holding'); done(); return; }
    raf = requestAnimationFrame(tick);
  };

  const done = () => {
    cancelAnimationFrame(raf);
    calibrating = { onComplete };
    worker.postMessage({ type: 'calibrate-finish' });
  };

  const cancel = () => {
    if (!active) return;
    active = false;
    cancelAnimationFrame(raf);
    button.classList.remove('holding');
    if (ui.fill && button === ui.hold) ui.fill.style.transform = 'scaleY(0)';
    if (label) button.textContent = label;
    worker?.postMessage({ type: 'calibrate-cancel' });
  };

  button.addEventListener('pointerdown', begin);
  button.addEventListener('pointerup', cancel);
  button.addEventListener('pointercancel', cancel);
  button.addEventListener('pointerleave', cancel);
  // Keyboard: space or enter holds for as long as the key is down.
  button.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') begin(e); });
  button.addEventListener('keyup', cancel);
}

function finishCalibration(ok) {
  const pending = calibrating;
  calibrating = null;
  if (!pending) return;
  pending.onComplete(ok);
}

wireHold(ui.hold, (ok) => {
  if (!ok) {
    ui.fill.style.transform = 'scaleY(0)';
    ui.hint.textContent = 'Something was still ringing. Let it die away and try again.';
    ui.hint.classList.add('error');
    return;
  }
  ui.hold.classList.add('done');
  ui.holdLabel.textContent = 'Ready';
  setTimeout(() => {
    ui.start.hidden = true;
    ui.tuner.hidden = false;
    running = true;
  }, 260);
});

wireHold(ui.recalibrate, (ok) => {
  ui.recalibrate.textContent = ok ? 'Room re-read' : 'Still ringing — try again';
  setTimeout(() => { ui.recalibrate.textContent = 'Re-read the room'; }, 1800);
}, { label: 'Re-read the room' });

ui.ref.addEventListener('click', () => {
  const steps = [415, 432, 438, 439, 440, 441, 442, 443, 444];
  a4 = steps[(steps.indexOf(a4) + 1) % steps.length];
  ui.refValue.textContent = a4;
  localStorage.setItem('tunedup.a4', String(a4));
  worker?.postMessage({ type: 'a4', value: a4 });
});

function showStartError(err) {
  ui.startError.hidden = false;
  ui.startError.textContent = err && err.name === 'NotAllowedError'
    ? 'TunedUp needs the microphone. Allow access and hold the button again.'
    : 'Could not open the microphone. Check that nothing else is using it.';
}

// ---- rendering -----------------------------------------------------------

function render(r, msg) {
  if (!running) return;
  // Last result, for tools/browser-test.mjs. Reading it is the only way to
  // tell a UI bug from a DSP one when the pipeline runs in a worker.
  window.__tunedup = r;

  if (msg.calibrating) {
    ui.status.textContent = 'Listening to the room — stay quiet.';
    ui.status.classList.remove('warn');
    return;
  }

  // Acknowledgement first, and never gated on the reading: the app can show a
  // pluck landed long before it knows what the pluck was.
  if (r.heard && performance.now() - lastHeard > 400) {
    lastHeard = performance.now();
    ui.meter.classList.remove('ack');
    void ui.meter.offsetWidth;
    ui.meter.classList.add('ack');
  }

  if (!r.heard) {
    ui.meter.classList.remove('live', 'good');
    ui.note.className = 'note idle';
    ui.note.textContent = '—';
    ui.octave.textContent = '';
    ui.cents.textContent = ' ';
    ui.direction.textContent = '';
    ui.status.textContent = 'Play a string.';
    ui.status.classList.remove('warn');
    return;
  }

  // A note is sounding but the reading is withheld: name the note if we have
  // it, and say WHY there is no number. "Show the reason whenever any gate
  // fired" is not decoration -- the prototype's failure was a tuner that went
  // quiet without ever saying what was wrong.
  if (!r.showReading) {
    ui.meter.classList.remove('live', 'good');
    ui.note.className = 'note idle';
    ui.note.textContent = r.note || '—';
    ui.octave.textContent = r.octave != null ? r.octave : '';
    ui.cents.textContent = ' ';
    ui.direction.textContent = '';
    const reason = (r.gates || []).map((g) => GATE_TEXT[g]).find(Boolean);
    ui.status.textContent = reason || 'Listening…';
    ui.status.classList.toggle('warn', Boolean(r.hardGate));
    return;
  }

  ui.meter.classList.add('live');
  ui.meter.classList.toggle('good', r.inTune);
  ui.note.className = r.inTune ? 'note good' : 'note';
  ui.note.textContent = r.note;
  ui.octave.textContent = r.octave;

  const clamped = Math.max(-50, Math.min(50, r.cents));
  ui.needle.style.left = `${50 + clamped}%`;

  // The band is what the tuner actually knows: +-2 sigma, and asymmetric while
  // the glide is being corrected away -- it spans the corrected reading to the
  // raw one, because that is the direction the correction moved it.
  const half = Math.min(45, 2 * r.sigma);
  const lo = Math.max(-50, clamped - half);
  const hi = Math.min(50, clamped + half + (r.d || 0));
  ui.band.style.left = `${50 + lo}%`;
  ui.band.style.width = `${hi - lo}%`;
  ui.band.style.transform = 'scaleX(1)';

  const shown = Math.abs(r.cents) < 0.5 ? 0 : r.cents;
  ui.cents.textContent = (shown > 0 ? '+' : shown < 0 ? '\u2212' : '')
    + Math.abs(shown).toFixed(1);

  if (r.inTune) {
    ui.direction.textContent = 'in tune';
    ui.status.textContent = '';
    ui.status.classList.remove('warn');
    return;
  }

  ui.direction.textContent = r.cents > 0 ? 'sharp' : 'flat';

  // The sign of the glide is worth saying out loud. It is always downward, so
  // when the reading is sharp and still falling the honest instruction is
  // "wait" -- which needs no model at all.
  const reason = (r.gates || []).map((g) => GATE_TEXT[g]).find(Boolean);
  if (r.d > 0.6 && r.cents > 0) ui.status.textContent = 'Still settling — give it a moment.';
  else if (r.d > 12) ui.status.textContent = 'Plucked hard — softer settles sooner.';
  else ui.status.textContent = reason || '';
  ui.status.classList.toggle('warn', Boolean(r.hardGate));
}

// ---- service worker ------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// Releasing the mic when the tab goes away is the difference between a tuner
// and a thing that holds the microphone hostage.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) audio?.suspend?.();
  else if (running) {
    audio?.resume?.();
    worker?.postMessage({ type: 'discontinuity' });
  }
});
