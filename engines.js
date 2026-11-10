// The two speech engines the page can use. Both have the same shape:
//   start()            begin listening
//   stop()             stop listening, mic off
//   resetTranscript()  forget what was heard so far (user clicked a word); restarts if stopped
// and report back through:
//   onTranscript(text)  full transcript of the current session, every time it changes
//   onNewSession()      the transcript starts empty again (align from the current word)
//   onState(text)       short status for the toolbar
import { deepgramUrl, createTranscriptCollector, KEEPALIVE_EVERY_MS, KEEPALIVE_MESSAGE, CLOSE_MESSAGE } from './deepgram.js';
import { createSilenceGate, loudness } from './silence-gate.js';

// ---------- Browser (free): Chrome/Edge/Safari built-in recognition, audio processed by the browser vendor ----------
export function createBrowserEngine({ language, onTranscript, onNewSession, onState }) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) throw new Error('This browser has no free speech engine. Use Chrome, Edge or Safari, or switch to AI.');
  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = language;
  let listening = false;

  recognition.onresult = event => onTranscript(Array.from(event.results, result => result[0].transcript).join(' '));
  recognition.onerror = event => {
    if (event.error === 'not-allowed') { listening = false; onState('Mic blocked'); }
  };
  recognition.onend = () => { // the browser stops after silence or abort(): carry on with a fresh session
    if (!listening) return;
    onNewSession();
    recognition.start();
  };

  const engine = {
    start() { listening = true; onNewSession(); recognition.start(); onState('Listening · free'); },
    stop() { listening = false; recognition.abort(); },
    resetTranscript() { listening ? recognition.abort() : engine.start(); }, // abort -> onend -> fresh session
  };
  return engine;
}

// ---------- AI (Deepgram Nova-3): mic audio streamed straight from this page to Deepgram with the user's key ----------
export function createDeepgramEngine({ apiKey, language, onTranscript, onNewSession, onState }) {
  const transcript = createTranscriptCollector();
  let socket = null, microphone = null, audioContext = null, running = false;

  async function start() {
    running = true;
    onState('Connecting to AI…');
    try {
      microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      // ponytail: asking for 16 kHz lets the browser resample. Works in Chrome/Safari; Firefox may refuse.
      audioContext = new AudioContext({ sampleRate: 16000 });
      await audioContext.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      socket = new WebSocket(deepgramUrl(language, audioContext.sampleRate), ['token', apiKey]);
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error('Could not connect to Deepgram. Check your API key in the ☰ menu.'));
      });
    } catch (error) {
      stop();
      onState(error.name === 'NotAllowedError' ? 'Mic blocked' : error.message);
      return;
    }
    if (!running) return stop(); // stopped while connecting

    transcript.reset();
    onNewSession();
    socket.onmessage = event => {
      const text = transcript.add(JSON.parse(event.data));
      if (text !== null) onTranscript(text);
    };
    socket.onclose = () => { if (running) { stop(); onState('AI disconnected · click a word to reconnect'); } };

    const chunker = new AudioWorkletNode(audioContext, 'pcm-chunker');
    audioContext.createMediaStreamSource(microphone).connect(chunker);
    const gate = createSilenceGate({ chunkMs: 320 / audioContext.sampleRate * 1000 });
    const stateLabels = {
      live: 'Listening · AI',
      paused: 'Paused (silence) · not billed',
      stopped: 'Stopped after 1 min of silence · click a word to resume',
    };
    let lastKeepAliveAt = 0;
    chunker.port.onmessage = ({ data: chunkBuffer }) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const stateBefore = gate.state;
      for (const chunkToSend of gate.process(chunkBuffer, loudness(new Int16Array(chunkBuffer)))) socket.send(chunkToSend);
      if (gate.state !== stateBefore) onState(stateLabels[gate.state]);
      if (gate.state === 'stopped') return stop();
      if (gate.state === 'paused' && performance.now() - lastKeepAliveAt > KEEPALIVE_EVERY_MS) {
        socket.send(KEEPALIVE_MESSAGE);
        lastKeepAliveAt = performance.now();
      }
    };
    onState(stateLabels.live);
  }

  function stop() {
    running = false;
    if (socket?.readyState === WebSocket.OPEN) socket.send(CLOSE_MESSAGE); // ends billing
    socket?.close();
    microphone?.getTracks().forEach(track => track.stop()); // mic light off
    audioContext?.close();
    socket = microphone = audioContext = null;
  }

  return {
    start,
    stop,
    resetTranscript() {
      if (!running) return start();
      transcript.reset();
      onNewSession();
    },
  };
}

// Opens and closes a Deepgram connection without sending audio (not billed). Resolves if the key works.
export function testDeepgramKey(apiKey) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(deepgramUrl('en', 16000), ['token', apiKey]);
    socket.onopen = () => { socket.close(); resolve(); };
    socket.onerror = () => reject(new Error('Deepgram rejected this key, or there is no internet connection.'));
  });
}
