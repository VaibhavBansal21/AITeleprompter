// Deepgram streaming details shared by the page (engines.js) and the benchmark (bench/deepgram.mjs).

export const KEEPALIVE_EVERY_MS = 3000;                               // keeps the connection open while paused
export const KEEPALIVE_MESSAGE = JSON.stringify({ type: 'KeepAlive' }); // not billed
export const CLOSE_MESSAGE = JSON.stringify({ type: 'CloseStream' });   // ends the session (and billing)

// language: 'en', 'hi', or a browser code like 'en-IN' (reduced to its base language; Nova-3 was tested with 'en' and 'hi').
export function deepgramUrl(language, sampleRate) {
  const baseLanguage = language.split('-')[0];
  return `wss://api.deepgram.com/v1/listen?model=nova-3&language=${baseLanguage}` +
    `&encoding=linear16&sample_rate=${sampleRate}&channels=1&interim_results=true`;
}

// Builds the session transcript from Deepgram messages: confirmed ("final") pieces + the latest guess ("interim").
export function createTranscriptCollector() {
  let finalTexts = [];
  let interimText = '';
  return {
    // Returns the full transcript after a Results message, or null for any other message type.
    add(message) {
      if (message.type !== 'Results') return null;
      const text = message.channel.alternatives[0].transcript; // Deepgram's top guess
      if (message.is_final) { if (text) finalTexts.push(text); interimText = ''; }
      else interimText = text;
      return `${finalTexts.join(' ')} ${interimText}`.trim();
    },
    reset() { finalTexts = []; interimText = ''; },
    get finalText() { return finalTexts.join(' '); },
  };
}
