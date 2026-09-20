// Streams contiguous microphone audio to the main thread. An AnalyserNode only
// hands out overlapping snapshots with no timing information; phase-based
// estimators need an unbroken sample stream with known absolute indices.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
