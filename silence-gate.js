// Silence gate: stops sending audio to a paid speech engine while nobody is speaking.
// Shared by the page (engines.js) and the benchmark (bench/deepgram.mjs).

// Average loudness (root-mean-square) of 16-bit samples. Room silence ~10-50, speech ~100-400 on a laptop mic.
export function loudness(samples /* Int16Array */) {
  let sumOfSquares = 0;
  for (const sample of samples) sumOfSquares += sample * sample;
  return Math.sqrt(sumOfSquares / samples.length);
}

// Feed it every audio chunk; it returns the chunks to send right now.
//   live:    every chunk is sent
//   paused:  after `pauseAfterMs` of silence, nothing is sent (not billed); the last chunks are held back
//   stopped: after `stopAfterMs` of silence; the caller should close the connection
// On resume, the held-back chunks are sent first so the first word isn't cut off.
export function createSilenceGate({
  threshold = 80,        // loudness below this = silence. Calibrated on rec_en_pause; knob because mics differ
  chunkMs = 20,          // duration of one chunk
  pauseAfterMs = 3000,
  stopAfterMs = 60000,
  preRollChunks = 10,    // 200 ms at 20 ms chunks
} = {}) {
  let silentForMs = 0;
  let state = 'live';
  let preRollBuffer = [];

  return {
    get state() { return state; },
    process(chunk, chunkLoudness) {
      silentForMs = chunkLoudness < threshold ? silentForMs + chunkMs : 0;
      if (silentForMs >= stopAfterMs) { state = 'stopped'; return []; }
      if (silentForMs >= pauseAfterMs) {
        state = 'paused';
        preRollBuffer.push(chunk);
        if (preRollBuffer.length > preRollChunks) preRollBuffer.shift();
        return [];
      }
      const toSend = state === 'paused' ? [...preRollBuffer, chunk] : [chunk];
      preRollBuffer = [];
      state = 'live';
      return toSend;
    },
  };
}
