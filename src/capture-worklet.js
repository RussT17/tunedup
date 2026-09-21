// The worklet does two things and nothing else: copy, and post.
//
// DESIGN §4 is specific about why. A 4096-point FFT inside a 2.67 ms render
// quantum causes dropouts, and a dropout puts a GAP IN THE PHASE RECORD, which
// is fatal to the tracker -- it is the one piece of state in this design that
// cannot survive a seam. So all analysis happens elsewhere, and this stays
// small enough that it cannot be the thing that overruns.
//
// The DC blocker lives on the worker side of the wire rather than here: it is
// a streaming filter either way, the worker sees every sample in order, and
// keeping the worklet to a copy means there is no filter state to lose when
// the audio graph is rebuilt.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.at = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.at++] = channel[i];
      if (this.at === this.buffer.length) {
        // Transfer, then re-allocate once per block rather than per sample.
        // Allocating 4096-float arrays a hundred times a second produces
        // periodic GC pauses that look exactly like dropouts.
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(1024);
        this.at = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
