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
let calibrating = null;   // { resolve, mode }

// Per-note display state. All three exist because a filmstrip of one pluck
// (tools/filmstrip.mjs) showed the UI doing things no value-checking test can
// see: acknowledging the same note six times, and calling a note that had just
// read perfectly "too much background noise" as it faded.
let lastSinceOnset = Infinity;
let gotReading = false;
let statusText = '';
let statusAt = 0;
const MIN_STATUS_MS = 700;    // a message holds the screen this long before
                              // another may replace it, so advice cannot flicker
const QUIET_GRACE_MS = 450;   // how long to try before admitting we cannot read

const RESTING = 'Play a string.';

function setStatus(text, warn = false) {
  const now = performance.now();
  if (text === statusText) return;
  // The resting message is not a message competing for the screen -- it is the
  // screen's default. Holding it back leaves the app blank for a second after
  // a note dies, which reads as a freeze rather than as calm.
  if (text !== RESTING && now - statusAt < MIN_STATUS_MS) return;
  statusText = text;
  statusAt = now;
  ui.status.textContent = text;
  ui.status.classList.toggle('warn', warn && Boolean(text));
}

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

  // Acknowledgement: ONCE per note, when the pluck lands.
  //
  // It is a separate channel from the reading (R4) and it arrives inside
  // 100 ms whether or not there is a number yet -- but it acknowledges the
  // PLUCK, and a pluck happens once. Re-firing it while the note is still
  // ringing turns a confirmation into a strobe, which is what it was doing
  // every 400 ms for the life of every note.
  const isNewNote = r.heard && r.sinceOnset < lastSinceOnset;
  lastSinceOnset = r.heard ? r.sinceOnset : Infinity;
  if (isNewNote) {
    gotReading = false;
    ui.meter.classList.remove('ack');
    void ui.meter.offsetWidth;
    ui.meter.classList.add('ack');
  }

  if (!r.heard) {
    ui.meter.classList.remove('live', 'good');
    ui.note.className = 'note idle';
    ui.note.textContent = '\u00b7';
    ui.octave.textContent = '';
    ui.cents.textContent = '\u00a0';
    ui.direction.textContent = '';
    setStatus(RESTING);
    return;
  }

  if (!r.showReading) {
    ui.meter.classList.remove('live', 'good');
    ui.note.className = 'note idle';
    ui.note.textContent = r.note || '\u00b7';
    ui.octave.textContent = r.octave != null ? r.octave : '';
    ui.cents.textContent = '\u00a0';
    ui.direction.textContent = '';

    // A note that HAS been read and is now fading is not a problem, and saying
    // anything about it is worse than saying nothing: "too much background
    // noise to tune here" is alarming, it is false, and it appeared one second
    // after the same note read to a tenth of a cent. Explain a gate only when
    // it is the reason the player never got a number at all -- and only after
    // giving the tracker a moment, so a warning does not flash during the
    // 400 ms every note spends warming up.
    if (gotReading) setStatus('');
    else if (r.sinceOnset < QUIET_GRACE_MS / 1000) setStatus('Listening\u2026');
    else {
      const reason = (r.gates || []).map((g) => GATE_TEXT[g]).find(Boolean);
      setStatus(reason || 'Listening\u2026', Boolean(r.hardGate));
    }
    return;
  }

  gotReading = true;
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
    setStatus('');
    return;
  }
  ui.direction.textContent = r.cents > 0 ? 'sharp' : 'flat';

  // Say something only when it changes what the player should do. The glide is
  // always downward, so when the reading is sharp and still falling the honest
  // instruction is "wait" -- which needs no model at all. Every soft gate is
  // true, and saying all of them all the time is how the last version of this
  // tuner became exhausting; surface one only when it is visibly costing
  // precision.
  // Coaching is only coaching if it arrives while the pluck is still the thing
  // you just did. At 1.8 s into a note it is a verdict on something you can no
  // longer change, and on a wound low E -- where theta is long, so d is large
  // on an ordinary pluck -- it was firing on takes recorded as "normal".
  if (r.d > 15 && r.sinceOnset < 1.2) setStatus('Plucked hard \u2014 softer settles sooner.');
  else if (r.d > 0.6 && r.cents > 0) setStatus('Still settling \u2014 give it a moment.');
  else setStatus(r.sigma > 2 ? ((r.gates || []).map((g) => GATE_TEXT[g]).find(Boolean) || '') : '');
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
