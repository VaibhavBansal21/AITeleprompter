# AI Teleprompter

A teleprompter that follows your voice word by word. Paste a script (or open a PDF / Word file), press Start and read aloud: the words you have said fade out, the next word lights up, and the text scrolls so your eyes stay near the camera.

Styled like Apple Music lyrics: spoken words turn blurry red, the next word is blue, and later sentences wait out of focus.

## Features

- **Follows your voice**: no fixed scroll speed. Pause, speed up or go off script and it keeps your place.
- **Handles real reading**: filler words ("um"), skipped words, skipped sentences, ad-libs and paraphrased lines.
- **English and Hindi**: language picked automatically from the script (Devanagari = Hindi), or chosen manually.
- **Two speech engines** (☰ menu):
  | Engine | Cost | Accuracy |
  |---|---|---|
  | Browser (Chrome/Edge/Safari built-in) | Free | Basic, may struggle with accents |
  | AI: Deepgram Nova-3 (your own API key) | ~$0.46 per hour of speaking | High, handles accents |
- **Silence-aware billing** (AI mode): stops sending audio after 3 s of silence, so pauses are not billed; disconnects after 1 min.
- **Script import**: `.txt`, `.pdf`, `.docx`.
- **Reading comfort**: day / night mode, adjustable font size, full screen (`F`), click any word to jump there.

## How it works

```
Mic ──▶ speech engine ──▶ transcript ──▶ align.js ──▶ highlight + autoscroll
         (browser or Deepgram)            (matches spoken words to the script)
```

- **Matching** ([align.js](align.js)): a pointer moves through the script. The next word or a one-word skip matches alone; a bigger jump needs 2–3 spoken words in a row to agree, so a stray "the" never jumps ahead. Unmatched words (fillers, ad-libs) are ignored. No word-length rules, so it works the same for Hindi.
- **Interim results**: the whole session transcript is re-aligned on every update, so the engine correcting its guess never double-advances the pointer.
- **AI engine** ([engines.js](engines.js)): mic audio is cut into 20 ms, 16-bit chunks on the audio thread ([pcm-worklet.js](pcm-worklet.js)) and streamed over a WebSocket directly from the browser to Deepgram.
- **Silence gate** ([silence-gate.js](silence-gate.js)): measures loudness per chunk; while paused it keeps the last 200 ms so the first word after a pause is not cut off.

There is no backend. Everything runs in the visitor's browser, so it is multi-user by design: every user has their own session and, in AI mode, their own key.

## Benchmark results

Measured with [bench/deepgram.mjs](bench/deepgram.mjs): 19 generated clips (macOS voices, English + Hindi) and 6 real recordings, streamed at real-time speed like a live mic.

| Question | Result |
|---|---|
| Does the highlight end on the right word? | **25 / 25** clips, including real-voice ad-libs and paraphrases in English and Hindi |
| Delay from word spoken to highlight (Deepgram) | ~0.4–0.55 s median; ~0.3 s of that is network round trip |
| Does silence cost money? | With the gate, billed audio fell from **445 s to 226 s**; a 90 s silence went from 93 s billed to 6 s |
| Cost | ~$0.46 per hour of streamed audio (Deepgram Nova-3 list price) |

## Run locally

Needs a browser with mic access (Chrome recommended). Pages must be served over `localhost` or HTTPS for the mic to work.

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Open http://localhost:8765. For AI mode, open ☰ → AI and paste a [Deepgram API key](https://console.deepgram.com/signup) ($200 free credit).

## Deploy

Static site, no build step. On [vercel.com](https://vercel.com): **Add New → Project → import this repo → Deploy** (framework preset: Other). Every push to `main` redeploys.

[vercel.json](vercel.json) sets security headers: scripts only from this site and jsDelivr (PDF/Word readers), network only to Deepgram, mic only for this site, no embedding in other sites.

## Tests and benchmark

```bash
node --test                                         # matching tests (English + Hindi scenarios)
node bench/gen_audio.mjs                            # build test audio (macOS `say`), converts rec_*.m4a recordings
node --env-file=.env bench/deepgram.mjs             # stream all clips to Deepgram, score accuracy/latency/cost
node --env-file=.env bench/deepgram.mjs --gate      # same, with the silence gate
```

`.env` holds `DEEPGRAM_API_KEY=...` (see [.env.example](.env.example)). Test audio and recordings are not committed.

## Project structure

```
index.html        page layout and styles
app.js            page logic: script loading, highlighting, menu, engine switching
align.js          matching spoken words to the script (shared with tests and benchmark)
engines.js        browser and Deepgram speech engines behind one interface
pcm-worklet.js    mic audio → 16-bit chunks (audio thread)
silence-gate.js   pause / stop sending audio on silence (shared with benchmark)
deepgram.js       Deepgram URL, messages and transcript handling (shared with benchmark)
extract.js        text from .txt / .pdf / .docx
fixtures/         test scripts and scenarios (English, Hindi)
bench/            audio generation and Deepgram benchmark
tests/            node:test suite
```

## Privacy

- Scripts never leave the browser.
- Browser engine: audio is processed by the browser vendor (Google in Chrome).
- AI engine: audio goes directly from the browser to Deepgram. Your API key is kept in the open tab only, unless you tick "Remember on this device" (then in this browser's local storage). It is never sent anywhere except Deepgram.

## Limitations

- Old `.doc` files and scanned (image-only) PDFs are not supported; some PDFs split words across lines.
- AI mode needs Chrome, Edge or Safari (Firefox may refuse 16 kHz mic capture).
- Forward-only matching: to re-read a passage, click the word to jump back.
