import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, mirrorOf, mirrorText, EMPTY_MIRROR } from '../src/mirror.js';

test('typing appends at the caret', () => {
  const r = applyOps(EMPTY_MIRROR, [{ text: 'かん' }]);
  assert.equal(mirrorText(r.mirror), 'かん');
  assert.equal(r.mirror.caret, 2);
});

test('゛゜小 edit replaces the previous character', () => {
  const r = applyOps(mirrorOf('はか'), [{ key: 'Backspace' }, { text: 'が' }]);
  assert.equal(mirrorText(r.mirror), 'はが');
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
});

test('moves past the ends and Backspace at the start change nothing', () => {
  const r = applyOps(mirrorOf('あ'), [{ key: 'ArrowRight' }, { key: 'ArrowLeft' }, { key: 'ArrowLeft' }, { key: 'Backspace' }]);
  assert.equal(r.mirror.caret, 0);
  assert.equal(mirrorText(r.mirror), 'あ');
});

test('symbols such as ～ stay in the reading', () => {
  const r = applyOps(EMPTY_MIRROR, [{ text: 'わ～' }]);
  assert.equal(mirrorText(r.mirror), 'わ～');
});
