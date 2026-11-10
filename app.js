// Page logic for index.html: script loading, highlighting, speech engines, menu.
import { norm, toWords, align } from './align.js';
import { extractText } from './extract.js';
import { createBrowserEngine, createDeepgramEngine, testDeepgramKey } from './engines.js';

const byId = id => document.getElementById(id);

// Per-device preferences (theme, font size, engine). Storage can be blocked, so failures are ignored.
const preferences = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* not saved, still works */ } },
  remove: key => { try { localStorage.removeItem(key); } catch { /* nothing to remove */ } },
};

let scriptWords = [];          // cleaned script words, compared against speech
let wordElements = [];         // one <span> per script word
let sentenceElements = [];     // one <p> per sentence
let sentenceOfWord = [];       // word index -> index of its sentence
let firstWordOfSentence = [];  // sentence index -> index of its first word
let position = 0;              // index of the next word to speak
let sessionStartPosition = 0;  // position when the current recognition session began
let lastStyledWords = [];      // words given a state class in the previous render
let currentScriptText = '';    // script being prompted (used to pick the language)
let engine = null;             // the running speech engine (browser or AI)
let engineState = '';          // engine status shown in the toolbar, e.g. "Paused (silence)"
// The Deepgram key lives in this variable only, unless the user ticked "Remember on this device".
let deepgramKey = preferences.get('deepgramKey');
let engineChoice = preferences.get('engine') === 'ai' && deepgramKey ? 'ai' : 'browser';

// ---------- Theme and font size ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  preferences.set('theme', theme);
  document.querySelectorAll('.theme-button').forEach(button => {
    button.textContent = theme === 'night' ? 'Day mode' : 'Night mode';
  });
}
const systemPrefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
applyTheme(preferences.get('theme') ?? (systemPrefersDark ? 'night' : 'day'));
document.querySelectorAll('.theme-button').forEach(button => {
  button.onclick = () => applyTheme(document.documentElement.dataset.theme === 'night' ? 'day' : 'night');
});

function applyFontSize(pixels) {
  const clamped = Math.min(160, Math.max(24, pixels));
  document.documentElement.style.setProperty('--font-size', `${clamped}px`);
  preferences.set('fontSize', clamped);
}
const currentFontSize = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--font-size'));
if (preferences.get('fontSize')) applyFontSize(+preferences.get('fontSize'));
byId('smaller-font-button').onclick = () => applyFontSize(currentFontSize() - 8);
byId('bigger-font-button').onclick = () => applyFontSize(currentFontSize() + 8);

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  document.documentElement.requestFullscreen()
    .catch(() => { byId('status').textContent = 'Full screen is blocked in this browser window'; });
}
byId('fullscreen-button').onclick = toggleFullscreen;
document.addEventListener('fullscreenchange', () => {
  byId('fullscreen-button').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
});
document.addEventListener('keydown', event => { // F toggles full screen while prompting
  const prompting = byId('prompter').style.display === 'block';
  if (prompting && event.key.toLowerCase() === 'f') toggleFullscreen();
});

// ---------- Script loading ----------
byId('file-input').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  byId('error-message').textContent = '';
  try {
    byId('script-input').value = await extractText(file);
  } catch (error) {
    byId('error-message').textContent = error.message;
  }
  event.target.value = ''; // lets the same file be picked again
};

// Builds one <p> per sentence and one <span> per word.
function buildPrompter(scriptText) {
  scriptWords = []; wordElements = []; sentenceElements = []; sentenceOfWord = []; firstWordOfSentence = [];
  byId('prompter').innerHTML = '';
  // A sentence ends at . ! ? or the Hindi danda, or at a line break.
  const sentences = scriptText.split(/(?<=[.!?।])\s+|\n+/);
  for (const sentenceText of sentences) {
    const tokens = sentenceText.split(/\s+/).filter(token => norm(token)); // ponytail: drops punctuation-only tokens like "—"
    if (!tokens.length) continue;
    const sentenceElement = document.createElement('p');
    firstWordOfSentence.push(scriptWords.length);
    for (const token of tokens) {
      const wordIndex = scriptWords.length;
      const wordElement = document.createElement('span');
      wordElement.className = 'word';
      wordElement.textContent = token;
      wordElement.onclick = () => jumpTo(wordIndex);
      sentenceElement.append(wordElement, ' ');
      scriptWords.push(norm(token));
      wordElements.push(wordElement);
      sentenceOfWord.push(sentenceElements.length);
    }
    sentenceElements.push(sentenceElement);
    byId('prompter').append(sentenceElement);
  }
}

// ---------- Highlighting ----------
function render() {
  const nextWordIndex = Math.min(position, scriptWords.length - 1);
  const activeSentence = sentenceOfWord[nextWordIndex];

  sentenceElements.forEach((sentenceElement, sentenceIndex) => {
    const state = sentenceIndex < activeSentence ? 'past' : sentenceIndex > activeSentence ? 'future' : 'active';
    sentenceElement.className = `sentence ${state}`;
    sentenceElement.style.setProperty('--sentences-away', Math.min(Math.abs(sentenceIndex - activeSentence), 4));
  });

  for (const wordElement of lastStyledWords) wordElement.className = 'word';
  lastStyledWords = [];
  const setWordState = (wordIndex, state) => {
    wordElements[wordIndex].className = `word ${state}`;
    lastStyledWords.push(wordElements[wordIndex]);
  };

  const sentenceStart = firstWordOfSentence[activeSentence];
  const sentenceEnd = firstWordOfSentence[activeSentence + 1] ?? scriptWords.length;
  for (let wordIndex = sentenceStart; wordIndex < sentenceEnd; wordIndex++) {
    if (wordIndex < position) setWordState(wordIndex, 'spoken');
    else if (wordIndex === position) setWordState(wordIndex, 'next');
    else {
      setWordState(wordIndex, 'upcoming');
      wordElements[wordIndex].style.setProperty('--words-ahead', wordIndex - position);
    }
  }
  if (position > 0) setWordState(position - 1, 'just-spoken'); // may sit in the previous sentence

  // Scroll only the text area so the next word's line sits a third of the way down (near the camera).
  const prompter = byId('prompter');
  const EYE_LINE = 0.33; // fraction of the text area height; lower number = closer to the top
  // Measured on screen, NOT with offsetTop: a blurred sentence (CSS filter) becomes the word's offsetParent,
  // so offsetTop turns tiny (~2px) and the view would jump back to the first sentence on every sentence change.
  const wordTopInTextArea = wordElements[nextWordIndex].getBoundingClientRect().top - prompter.getBoundingClientRect().top;
  prompter.scrollTo({
    top: prompter.scrollTop + wordTopInTextArea - prompter.clientHeight * EYE_LINE,
    behavior: 'smooth',
  });
  updateStatus();
}

function updateStatus() {
  const progress = position >= scriptWords.length ? 'Done' : `${position} / ${scriptWords.length}`;
  byId('status').textContent = [progress, engineState].filter(Boolean).join(' · ');
}

function jumpTo(wordIndex) {
  position = sessionStartPosition = wordIndex;
  engine?.resetTranscript(); // forget old speech, align from here (restarts the engine if it had stopped)
  render();
}

// ---------- Speech ----------
function showScreen(prompting) {
  byId('setup').style.display = prompting ? 'none' : 'block';
  byId('prompter').style.display = prompting ? 'block' : 'none';
  byId('toolbar').style.display = prompting ? 'flex' : 'none';
}

// Which accent model Chrome uses. Auto: Hindi for Devanagari scripts, else Indian English.
const languageSelect = byId('language-select');
languageSelect.value = preferences.get('language') ?? 'auto';
languageSelect.onchange = () => preferences.set('language', languageSelect.value);
function speechLanguage(scriptText) {
  if (languageSelect.value !== 'auto') return languageSelect.value;
  return /\p{Script=Devanagari}/u.test(scriptText) ? 'hi-IN' : 'en-IN';
}

// Creates the chosen engine; both report the same way, so the matching code below doesn't care which one runs.
function createEngine() {
  const callbacks = {
    language: speechLanguage(currentScriptText),
    // Re-align the whole session transcript each time, so interim corrections never double-advance.
    onTranscript: transcript => {
      position = align(scriptWords, toWords(transcript), sessionStartPosition);
      render();
      if (position >= scriptWords.length) { engine.stop(); engineState = ''; updateStatus(); } // end of script: mic off
    },
    onNewSession: () => { sessionStartPosition = position; },
    onState: state => { engineState = state; updateStatus(); },
  };
  return engineChoice === 'ai'
    ? createDeepgramEngine({ apiKey: deepgramKey, ...callbacks })
    : createBrowserEngine(callbacks);
}

function startEngine() {
  engine?.stop();
  try {
    engine = createEngine();
    engine.start();
  } catch (error) {
    engine = null;
    engineState = error.message;
    updateStatus();
  }
}

function stopEngine() {
  engine?.stop();
  engine = null;
  engineState = '';
}

function start() {
  currentScriptText = byId('script-input').value;
  buildPrompter(currentScriptText);
  if (!scriptWords.length) { byId('error-message').textContent = 'Add a script first.'; return; }
  position = sessionStartPosition = 0;
  showScreen(true);
  render();
  startEngine();
}

byId('start-button').onclick = start;
byId('edit-button').onclick = () => { stopEngine(); showScreen(false); };

// ---------- ☰ menu: Browser (free) or AI (Deepgram) ----------
const keyDialog = byId('key-dialog');
const isPrompting = () => byId('prompter').style.display === 'block';

function syncMenu() { // makes the menu match the current choice and key
  document.querySelectorAll('input[name="engine"]').forEach(radio => { radio.checked = radio.value === engineChoice; });
  byId('change-key-button').hidden = byId('remove-key-button').hidden = !deepgramKey;
}

function chooseEngine(choice) {
  engineChoice = choice;
  preferences.set('engine', choice);
  syncMenu();
  if (isPrompting()) startEngine(); // switch mid-script: continues from the current word
}

function askForKey() {
  byId('menu').hidePopover();
  byId('key-error').textContent = '';
  keyDialog.showModal();
}

document.querySelectorAll('input[name="engine"]').forEach(radio => {
  radio.onchange = () => (radio.value === 'ai' && !deepgramKey ? askForKey() : chooseEngine(radio.value));
});
byId('change-key-button').onclick = askForKey;
byId('remove-key-button').onclick = () => {
  deepgramKey = null;
  preferences.remove('deepgramKey');
  if (engineChoice === 'ai') chooseEngine('browser'); else syncMenu();
};

byId('key-form').onsubmit = async event => {
  if (event.submitter?.value !== 'enable') return; // Cancel just closes the dialog
  event.preventDefault();
  const key = byId('key-input').value.trim();
  byId('key-error').textContent = 'Checking key with Deepgram…';
  try {
    await testDeepgramKey(key);
  } catch (error) {
    byId('key-error').textContent = error.message;
    return;
  }
  deepgramKey = key;
  if (byId('remember-key').checked) preferences.set('deepgramKey', key);
  else preferences.remove('deepgramKey');
  byId('key-input').value = '';
  keyDialog.close();
  chooseEngine('ai');
};
keyDialog.onclose = syncMenu; // cancelled without a key: radio goes back to Browser
syncMenu();
