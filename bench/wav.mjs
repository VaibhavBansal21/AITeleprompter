import { readFileSync } from 'node:fs';

export const RATE = 16000;       // all bench audio: 16 kHz, mono
export const BYTES_PER_SAMPLE = 2; // 16-bit PCM

export const secondsOf = samples => samples.length / RATE / BYTES_PER_SAMPLE;

// Returns the raw audio ('data' chunk) of a WAV file. Walks chunks because afconvert/say may add extra ones.
export function pcm(file) {
  const bytes = readFileSync(file);
  for (let offset = 12; offset < bytes.length; offset += 8 + bytes.readUInt32LE(offset + 4)) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    if (chunkId === 'data') return bytes.subarray(offset + 8, offset + 8 + chunkSize);
  }
  throw new Error(`no data chunk in ${file}`);
}
