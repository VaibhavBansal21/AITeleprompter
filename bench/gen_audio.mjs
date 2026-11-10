// Builds test audio in fixtures/audio/ as 16 kHz mono 16-bit WAV:
//  1. User recordings rec_*.m4a (Voice Memos etc.) -> rec_*.wav
//  2. Every fixture scenario -> <lang>_<scenario>.wav, spoken by macOS `say`.
//     `[[slnc 20000]]` in fixture text = 20 s of real silence (some voices ignore say's own silence command).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RATE, BYTES_PER_SAMPLE, pcm, secondsOf } from './wav.mjs';

const audioDir = new URL('../fixtures/audio/', import.meta.url).pathname;
mkdirSync(audioDir, { recursive: true });

// `say` randomly truncates output but is deterministic otherwise, so accept two identical-length renders in a row.
function speak(voice, text) {
  const tempFile = `${tmpdir()}/say_${process.pid}.wav`;
  let previousRender = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    execFileSync('say', ['-v', voice, '-o', tempFile, '--file-format=WAVE', `--data-format=LEI16@${RATE}`, text]);
    const render = Buffer.from(pcm(tempFile));
    if (previousRender && render.length === previousRender.length) return render;
    previousRender = render;
  }
  throw new Error(`say output unstable for: ${text}`);
}

const silenceSamples = ms => Buffer.alloc(Math.round(ms * RATE / 1000) * BYTES_PER_SAMPLE); // zeros = silence

function toWavFile(samples) { // standard 44-byte PCM WAV header + audio
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);       // file size - 8
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);                       // fmt chunk size
  header.writeUInt16LE(1, 20);                        // format: PCM
  header.writeUInt16LE(1, 22);                        // channels: mono
  header.writeUInt32LE(RATE, 24);                     // samples per second
  header.writeUInt32LE(RATE * BYTES_PER_SAMPLE, 28);  // bytes per second
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);         // bytes per sample frame
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);     // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

// 1. User recordings
for (const recordingFile of readdirSync(audioDir).filter(name => /^rec_.+\.(m4a|mp3|aiff?|caf)$/.test(name))) {
  const wavFile = recordingFile.replace(/\.\w+$/, '.wav');
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', audioDir + recordingFile, audioDir + wavFile]);
  console.log(`${wavFile}  ${secondsOf(pcm(audioDir + wavFile)).toFixed(1)}s  (recording)`);
}

// 2. Synthetic scenarios
for (const lang of ['en', 'hi']) {
  const fixture = JSON.parse(readFileSync(new URL(`../fixtures/${lang}.json`, import.meta.url)));
  for (const scenario of fixture.scenarios) {
    // "text [[slnc 20000]] text" -> ['text', '20000', 'text']: even index = speech, odd index = silence ms
    const pieces = scenario.spoken.split(/\[\[slnc (\d+)\]\]/);
    const samples = Buffer.concat(pieces.map((piece, index) => {
      const isSilence = index % 2 === 1;
      if (isSilence) return silenceSamples(+piece);
      return piece.trim() ? speak(fixture.voice, piece) : Buffer.alloc(0);
    }));
    const fileName = `${lang}_${scenario.name}.wav`;
    writeFileSync(audioDir + fileName, toWavFile(samples));
    console.log(`${fileName}  ${secondsOf(samples).toFixed(1)}s`);
  }
}
