// Streams fixture WAVs to Deepgram at real-time pace (like a live mic) and scores the result with align.js.
// Usage: node --env-file=.env bench/deepgram.mjs [--gate] [--silence-threshold=80] [filename-filter]
//   --gate  silence gate: >3 s quiet = Paused (stop sending audio, send KeepAlive), >60 s quiet = Stopped (close).
// Uses the same silence gate and transcript code as the page (../silence-gate.js, ../deepgram.js).
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { toWords, align } from '../align.js';
import { createSilenceGate, loudness } from '../silence-gate.js';
import { deepgramUrl, createTranscriptCollector, KEEPALIVE_EVERY_MS, KEEPALIVE_MESSAGE, CLOSE_MESSAGE } from '../deepgram.js';
import { RATE, BYTES_PER_SAMPLE, pcm, secondsOf } from './wav.mjs';

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
if (!DEEPGRAM_KEY) throw new Error('DEEPGRAM_API_KEY missing: put it in .env');

const args = process.argv.slice(2);
const USE_SILENCE_GATE = args.includes('--gate');
const silenceThresholdArg = args.find(a => a.startsWith('--silence-threshold='))?.split('=')[1];
const fileFilter = args.find(a => !a.startsWith('--')) ?? '';

const PRICE_PER_MINUTE = 0.0077; // ponytail: Nova-3 streaming list price (Nov 2026), verify on deepgram.com/pricing
const CHUNK_MS = 20;             // mic sends audio in 20 ms pieces
const BYTES_PER_CHUNK = RATE * BYTES_PER_SAMPLE * CHUNK_MS / 1000;

const audioDir = new URL('../fixtures/audio/', import.meta.url).pathname;
const fixtures = Object.fromEntries(['en', 'hi'].map(lang =>
  [lang, JSON.parse(readFileSync(new URL(`../fixtures/${lang}.json`, import.meta.url)))]));

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const runStartedAt = performance.now();
const log = text => console.log(`[${((performance.now() - runStartedAt) / 1000).toFixed(1).padStart(5)}s] ${text}`);
// Buffer slice -> Int16Array (copied, so the 2-byte alignment Int16Array needs is guaranteed)
const samplesOf = chunk => new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length));

// en_x.wav -> fixture scenario x. rec_en_x.wav -> user recording, must reach end of script.
function testCases() {
  return readdirSync(audioDir).filter(f => f.endsWith('.wav') && f.includes(fileFilter)).map(file => {
    const [, isRecording, lang, name] = file.match(/^(rec_)?(en|hi)_(.+)\.wav$/);
    const script = toWords(fixtures[lang].script);
    const scenario = isRecording ? { expected: script.length } : fixtures[lang].scenarios.find(s => s.name === name);
    return { file, lang, script, start: scenario.start ?? 0, expected: scenario.expected };
  });
}

async function runTest(testCase) {
  const audio = pcm(audioDir + testCase.file);
  const socket = new WebSocket(deepgramUrl(testCase.lang, RATE), ['token', DEEPGRAM_KEY]);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('connect failed (bad key or unsupported language?)'));
  });
  log(`${testCase.file}: connected, streaming ${secondsOf(audio).toFixed(1)}s of audio`);

  const transcript = createTranscriptCollector();
  const chunkSentAt = [];   // wall-clock time each chunk was sent; index = Deepgram's audio clock / CHUNK_MS
  const latenciesMs = [];   // result arrival - when that word's audio was sent
  let newestAudioSeen = 0;  // audio time (s) of the latest word Deepgram has shown so far
  let pointer = testCase.start, billedSeconds = 0, finishedSending = false, closedEarly = false;

  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'Metadata') billedSeconds = message.duration;
    const text = transcript.add(message);
    if (text === null) return;
    // Same as the page: re-align the whole session transcript, so interim corrections never double-advance.
    pointer = align(testCase.script, toWords(text), testCase.start);

    // Time each word only on first appearance: a later "final" re-sending an already-shown word
    // is not a delay the reader sees (the highlight already moved on the interim).
    const newestWord = message.channel.alternatives[0].words.at(-1);
    if (!newestWord || newestWord.end <= newestAudioSeen) return;
    newestAudioSeen = newestWord.end;
    const chunkIndex = Math.min(chunkSentAt.length - 1, Math.ceil(newestWord.end * 1000 / CHUNK_MS) - 1);
    if (chunkSentAt[chunkIndex]) latenciesMs.push(performance.now() - chunkSentAt[chunkIndex]);
  };
  const socketClosed = new Promise(resolve => { socket.onclose = () => { closedEarly = !finishedSending; resolve(); }; });

  const gate = USE_SILENCE_GATE
    ? createSilenceGate({ chunkMs: CHUNK_MS, ...(silenceThresholdArg && { threshold: +silenceThresholdArg }) })
    : null;
  const startTime = performance.now();
  let lastKeepAliveAt = 0, pausedSeconds = 0;

  for (let i = 0; i * BYTES_PER_CHUNK < audio.length && socket.readyState === WebSocket.OPEN; i++) {
    await sleep(startTime + i * CHUNK_MS - performance.now()); // real-time pace, like a live mic
    const chunk = audio.subarray(i * BYTES_PER_CHUNK, (i + 1) * BYTES_PER_CHUNK);
    if (!gate) { socket.send(chunk); chunkSentAt.push(performance.now()); continue; }

    const stateBefore = gate.state;
    for (const chunkToSend of gate.process(chunk, loudness(samplesOf(chunk)))) {
      socket.send(chunkToSend);
      chunkSentAt.push(performance.now());
    }
    if (gate.state !== stateBefore) log(`${testCase.file}: ${gate.state.toUpperCase()}`);
    if (gate.state === 'stopped') break;
    if (gate.state === 'paused') {
      pausedSeconds += CHUNK_MS / 1000;
      if (performance.now() - lastKeepAliveAt > KEEPALIVE_EVERY_MS) { socket.send(KEEPALIVE_MESSAGE); lastKeepAliveAt = performance.now(); }
    }
  }
  finishedSending = true;
  if (socket.readyState === WebSocket.OPEN) socket.send(CLOSE_MESSAGE);
  await socketClosed;

  latenciesMs.sort((a, b) => a - b);
  const percentile = p => (latenciesMs.length ? Math.round(latenciesMs[Math.floor(p * (latenciesMs.length - 1))]) : null);
  return {
    file: testCase.file, ok: pointer === testCase.expected, reached: pointer, expected: testCase.expected,
    medianMs: percentile(0.5), p95Ms: percentile(0.95),
    audioS: +secondsOf(audio).toFixed(1), billedS: +billedSeconds.toFixed(1), pausedS: +pausedSeconds.toFixed(1),
    state: gate?.state ?? 'live', closedEarly, transcript: transcript.finalText,
  };
}

const cases = testCases();
const longestSeconds = Math.max(...cases.map(tc => secondsOf(pcm(audioDir + tc.file))));
log(`Streaming ${cases.length} clips to Deepgram in parallel${USE_SILENCE_GATE ? ' WITH silence gate' : ''}, ~${Math.ceil(longestSeconds)}s total`);
let clipsDone = 0;
const heartbeat = setInterval(() => log(`... ${clipsDone}/${cases.length} clips done`), 10000);
const results = await Promise.all(cases.map(tc => runTest(tc)
  .then(row => { log(`${tc.file}: done, reached word ${row.reached}/${row.expected} ${row.ok ? 'OK' : 'MISS'}`); return row; })
  .catch(e => { log(`${tc.file}: ERROR ${e.message}`); return { file: tc.file, error: e.message }; })
  .finally(() => clipsDone++)));
clearInterval(heartbeat);
console.table(results.map(({ transcript, ...row }) => row));
const totalBilled = results.reduce((sum, r) => sum + (r.billedS ?? 0), 0);
console.log(`billed ${totalBilled.toFixed(1)} s ≈ $${(totalBilled / 60 * PRICE_PER_MINUTE).toFixed(4)}` +
  ` | list price $${(60 * PRICE_PER_MINUTE).toFixed(2)} per hour of streamed audio`);
mkdirSync(new URL('results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`results/deepgram${USE_SILENCE_GATE ? '-gate' : ''}.json`, import.meta.url), JSON.stringify(results, null, 2));
