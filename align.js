// Shared by the browser page, tests and benchmarks. Single source of matching logic.

// NFC keeps precomposed vs decomposed Devanagari (e.g. ड़) equal; \p{M} keeps Hindi vowel signs.
export const norm = w =>
  w.normalize('NFC').toLowerCase().replace(/’/g, "'").replace(/[^\p{L}\p{M}\p{N}']/gu, '');

export const toWords = text => text.split(/\s+/).map(norm).filter(Boolean);

// Advance pointer through script for each spoken word. Unmatched spoken words (fillers, ad-libs) are ignored.
// Next word or one-word skip matches alone; farther jumps need consecutive spoken words to agree
// (2 within 6 words, 3 beyond), so a stray common word never jumps. Language-agnostic: no word-length rules.
// ponytail: forward-only, maxJump caps cost and false jumps; re-reading backwards = user clicks a word.
export function align(script, spoken, pos, maxJump = 60) {
  for (let spokenIndex = 0; spokenIndex < spoken.length; spokenIndex++) {
    const spokenWord = spoken[spokenIndex];
    if (script[pos] === spokenWord) { pos++; continue; }          // expected next word
    if (script[pos + 1] === spokenWord) { pos += 2; continue; }   // reader skipped one word
    for (let candidate = pos + 2; candidate < Math.min(pos + maxJump, script.length); candidate++) {
      const wordsNeeded = candidate - pos < 6 ? 2 : 3;            // farther jump = stronger proof
      const run = spoken.slice(spokenIndex, spokenIndex + wordsNeeded);
      if (run.length === wordsNeeded && run.every((word, offset) => script[candidate + offset] === word)) {
        pos = candidate + 1;
        break;
      }
    }
  }
  return pos;
}
