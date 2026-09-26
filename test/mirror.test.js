import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, mirrorOf, mirrorText, EMPTY_MIRROR } from '../src/mirror.js';
import { KEYSYM } from '../src/romaji.js';

/**
 * Describe strokes as readable names.
 * @param {{keyval: number}[]} strokes - Strokes
 * @returns {string} Names joined by spaces
 * @example
 * names([{ keyval: 0xff08 }]) // "BS"
 */
const names = (strokes) => strokes.map(({ keyval }) => ({
  [KEYSYM.BackSpace]: 'BS',
  [KEYSYM.Left]: 'L',
  [KEYSYM.Right]: 'R',
}[keyval] ?? String.fromCharCode(keyval))).join(' ');

test('typing appends romaji', () => {
  const r = applyOps(EMPTY_MIRROR, [{ text: 'かん' }]);
  assert.equal(mirrorText(r.mirror), 'かん');
  assert.equal(r.mirror.caret, 2);
  assert.equal(names(r.strokes), 'k a n n');
});

test('゛゜小 edit becomes BackSpace plus new romaji', () => {
  const r = applyOps(mirrorOf('はか'), [{ key: 'Backspace' }, { text: 'が' }]);
  assert.equal(mirrorText(r.mirror), 'はが');
  assert.equal(names(r.strokes), 'BS g a');
});

test('caret moves and inserts in the middle', () => {
  let r = applyOps(mirrorOf('あいう'), [{ key: 'ArrowLeft' }, { key: 'ArrowLeft' }]);
  assert.equal(r.mirror.caret, 1);
  r = applyOps(r.mirror, [{ text: 'か' }]);
  assert.equal(mirrorText(r.mirror), 'あかいう');
  assert.equal(r.mirror.caret, 2);
  r = applyOps(r.mirror, [{ key: 'Backspace' }, { key: 'ArrowRight' }]);
  assert.equal(mirrorText(r.mirror), 'あいう');
  assert.equal(r.mirror.caret, 2);
  assert.equal(names(r.strokes), 'BS R');
});

test('moves past the ends and Backspace at the start send nothing', () => {
  const r = applyOps(mirrorOf('あ'), [{ key: 'ArrowRight' }, { key: 'ArrowLeft' }, { key: 'ArrowLeft' }, { key: 'Backspace' }]);
  assert.equal(r.mirror.caret, 0);
  assert.equal(mirrorText(r.mirror), 'あ');
  assert.equal(names(r.strokes), 'L');
});

test('untypable characters are not inserted', () => {
  const r = applyOps(EMPTY_MIRROR, [{ text: 'あ字' }]);
  assert.equal(mirrorText(r.mirror), 'あ');
  assert.deepEqual(r.skipped, ['字']);
});
