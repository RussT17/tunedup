// A thin shell around the engine. Everything interesting is in src/dsp, which
// is why tools/ can measure it.
import { Engine } from './dsp/engine.js';

let engine = null;
let lastPost = 0;

self.onmessage = (event) => {
  const msg = event.data;
  if (msg && msg.type === 'init') {
    engine = new Engine(msg.sampleRate, { a4: msg.a4 });
    self.postMessage({ type: 'ready' });
    return;
  }
  if (!engine) return;
  switch (msg && msg.type) {
    case 'audio': feed(new Float32Array(msg.buffer)); break;
    case 'calibrate-begin': engine.beginCalibration(); break;
    case 'calibrate-finish':
      self.postMessage({ type: 'calibrated', ok: engine.finishCalibration() });
      break;
    case 'calibrate-cancel': engine.cancelCalibration(); break;
    case 'a4': engine.setA4(msg.value); break;
    case 'discontinuity': engine.discontinuity(); break;
    default: break;
  }
};

function feed(samples) {
  const result = engine.push(samples);
  // The UI cannot use 100 updates a second and the structured clone is not
  // free, so post at display rate. The engine still runs every hop -- the
  // phase record has no gaps in it.
  const now = performance.now();
  if (now - lastPost < 28 && !result.inTune) return;
  lastPost = now;
  self.postMessage({ type: 'result', result, calibrating: engine.calibrating, calFrames: engine.room.calFrames });
}
