import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { norm, toWords, align } from '../align.js';

const load = lang => JSON.parse(readFileSync(new URL(`../fixtures/${lang}.json`, import.meta.url)));
const stripSay = s => s.replace(/\[\[.*?\]\]/g, ' '); // drop `say` silence commands

for (const lang of ['en', 'hi']) {
  const fx = load(lang);
  const script = toWords(fx.script);

  test(`${lang}: clean scenario covers whole script`, () => {
    assert.equal(fx.scenarios.find(s => s.name === 'clean').expected, script.length);
  });

  for (const s of fx.scenarios) {
    test(`${lang}: ${s.name}`, () => {
      assert.equal(align(script, toWords(stripSay(s.spoken)), s.start ?? 0), s.expected);
    });
  }
}

test('norm keeps Hindi vowel signs, strips punctuation', () => {
  assert.equal(norm('दोस्तों,'), 'दोस्तों');
  assert.equal(norm('करेंगे।'), 'करेंगे');
  assert.equal(norm('Don’t!'), "don't");
  assert.equal(norm('ड़'), norm('ड़')); // ड़ precomposed == decomposed
});

test('align is fast enough for live updates', () => {
  const script = Array.from({ length: 5000 }, (_, i) => `w${i}`);
  const spoken = script.slice(0, 300); // ~2 min of speech re-aligned per update
  const t = performance.now();
  for (let i = 0; i < 100; i++) align(script, spoken, 0);
  const ms = (performance.now() - t) / 100;
  console.log(`align: ${ms.toFixed(3)} ms per update`);
  assert.ok(ms < 5);
});
