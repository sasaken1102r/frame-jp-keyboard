import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kanaToRomaji, textToStrokes, isTypable, KEYSYM } from '../src/romaji.js';
import { KANA_KEYS } from '../src/kana-table.js';
import { cycleModifier } from '../src/modifiers.js';

/**
 * Render strokes as a string of their characters.
 * @param {{keyval: number}[]} strokes - Strokes
 * @returns {string} Characters
 * @example
 * keys(textToStrokes('か').strokes) // "ka"
 */
const keys = (strokes) => strokes.map((s) => String.fromCharCode(s.keyval)).join('');

test('complete, unambiguous romaji', () => {
  assert.equal(keys(textToStrokes('かんじ').strokes), 'kannzi');
  assert.equal(keys(textToStrokes('こんにちは').strokes), 'konnnitiha');
  assert.equal(keys(textToStrokes('きょう').strokes), 'kixyou');
  assert.equal(keys(textToStrokes('がっこう').strokes), 'gaxtukou');
  assert.equal(keys(textToStrokes('「ー」、。？！').strokes), '[-],.?!');
  assert.equal(kanaToRomaji('ヴ'), 'vu');
});

test('every character a kana key or ゛゜小 can produce is typable', () => {
  const produced = new Set();
  for (const key of Object.values(KANA_KEYS)) {
    for (const ch of [...key.flick, ...key.toggle]) if (ch) produced.add(ch);
  }
  // Follow the ゛゜小 cycles from every produced character.
  for (const start of [...produced]) {
    let ch = cycleModifier(start);
    while (ch && !produced.has(ch)) {
      produced.add(ch);
      ch = cycleModifier(ch);
    }
  }
  const missing = [...produced].filter((ch) => !isTypable(ch));
  assert.deepEqual(missing, []);
});

test('untypable characters are skipped and reported', () => {
  const result = textToStrokes('あ漢い');
  assert.equal(keys(result.strokes), 'ai');
  assert.deepEqual(result.skipped, ['漢']);
});


test('IBus engine reports unavailable without the native binding', async () => {
  const { createIBusEngine } = await import('../src/ibus.js');
  const saved = console.warn;
  console.warn = () => {};
  try {
    const engine = createIBusEngine({ onCommit: () => {}, onUpdate: () => {} });
    assert.equal(await engine.init(), false);
  } finally {
    console.warn = saved;
  }
});
