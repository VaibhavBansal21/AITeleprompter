// Runs on the browser's audio thread. Turns mic audio (32-bit float samples, -1..1)
// into chunks of 16-bit PCM, the format Deepgram expects, and posts each chunk to the page.
const CHUNK_SAMPLES = 320; // 20 ms at 16 kHz

class PcmChunker extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process([input]) {
    const monoSamples = input[0];
    if (!monoSamples) return true; // no mic data this frame
    for (const sample of monoSamples) {
      this.chunk[this.filled++] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
      if (this.filled === CHUNK_SAMPLES) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]); // hand over without copying
        this.chunk = new Int16Array(CHUNK_SAMPLES);
        this.filled = 0;
      }
    }
    return true; // keep running
  }
}

registerProcessor('pcm-chunker', PcmChunker);
