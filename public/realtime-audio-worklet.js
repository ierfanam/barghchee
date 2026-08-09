class RealtimeInputProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    // Float32 PCM is forwarded to the main thread. Resampling/encoding is
    // intentionally kept outside the render callback to avoid blocking audio.
    this.port.postMessage(new Float32Array(input[0]));
    return true;
  }
}

registerProcessor('realtime-input-processor', RealtimeInputProcessor);
