import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposer } from '../src/composer.js';
import { normalizeSettings } from '../src/settings.js';

const BS = { key: 'Backspace' };
const make = (overrides = {}) => createComposer(() => ({ toggleInput: false, toggleTimeoutMs: 800, ...overrides }));

test('flicks commit kana directly', () => {
  const c = make();
  assert.deepEqual(c.input('a', 'center'), [{ text: 'あ' }]);
  assert.deepEqual(c.input('a', 'left'), [{ text: 'い' }]);
  assert.deepEqual(c.input('a', 'up'), [{ text: 'う' }]);
  assert.equal(c.tail, 'あいう');
  assert.deepEqual(c.input('wa', 'down'), []);
});

test('゛゜小 replaces the previous character', () => {
  const c = make();
  c.input('ha', 'center');
  assert.deepEqual(c.modify(), [BS, { text: 'ば' }]);
  assert.deepEqual(c.modify(), [BS, { text: 'ぱ' }]);
  assert.deepEqual(c.modify(), [BS, { text: 'は' }]);
  assert.equal(c.tail, 'は');
  c.input('wa', 'up'); // ん has no variants
  assert.deepEqual(c.modify(), []);
});

test('゛゜小 does nothing without known text', () => {
  const c = make();
  assert.deepEqual(c.modify(), []);
  c.input('ka', 'center');
  c.arrow('left');
  assert.deepEqual(c.modify(), []);
});

test('undo reverts typing, modify and backspace', () => {
  const c = make();
  c.input('ka', 'center');
  c.input('ta', 'up');
  c.modify(); // つ -> っ
  assert.equal(c.tail, 'かっ');
  assert.deepEqual(c.undo(), [BS, { text: 'つ' }]);
  assert.equal(c.tail, 'かつ');
  assert.deepEqual(c.backspace(), [BS]);
  assert.equal(c.tail, 'か');
  assert.deepEqual(c.undo(), [{ text: 'つ' }]);
  assert.equal(c.tail, 'かつ');
  assert.deepEqual(c.undo(), [BS]);
  assert.deepEqual(c.undo(), [BS]);
  assert.deepEqual(c.undo(), []);
  assert.equal(c.tail, '');
});

test('backspace over unknown text clears history', () => {
  const c = make();
  c.input('a', 'center');
  c.backspace();
  assert.deepEqual(c.backspace(), [BS]); // deletes something we never typed
  assert.deepEqual(c.undo(), []);
});

test('enter and arrows send special keys and forget', () => {
  const c = make();
  c.input('a', 'center');
  assert.deepEqual(c.enter(), [{ key: 'Enter' }]);
  assert.deepEqual(c.undo(), []);
  assert.deepEqual(c.arrow('left'), [{ key: 'ArrowLeft' }]);
  assert.deepEqual(c.arrow('right'), [{ key: 'ArrowRight' }]);
  assert.equal(c.tail, '');
});

test('space is typed text and undoable', () => {
  const c = make();
  assert.deepEqual(c.typeText(' '), [{ text: ' ' }]);
  assert.deepEqual(c.undo(), [BS]);
});

test('toggle input cycles repeated taps within the timeout', () => {
  const c = make({ toggleInput: true });
  assert.deepEqual(c.input('a', 'center', 1000), [{ text: 'あ' }]);
  assert.deepEqual(c.input('a', 'center', 1500), [BS, { text: 'い' }]);
  assert.deepEqual(c.input('a', 'center', 2000), [BS, { text: 'う' }]);
  assert.equal(c.tail, 'う');
  // Too slow: a new あ.
  assert.deepEqual(c.input('a', 'center', 3000), [{ text: 'あ' }]);
  assert.equal(c.tail, 'うあ');
  // Undo steps back one toggle.
  c.input('a', 'center', 3100);
  assert.deepEqual(c.undo(), [BS, { text: 'あ' }]);
});

test('toggle input wraps and resets on other keys', () => {
  const c = make({ toggleInput: true });
  let t = 0;
  for (let i = 0; i < 6; i++) c.input('ta', 'center', (t += 100));
  assert.equal(c.tail, 'っ');
  c.input('ta', 'center', (t += 100));
  assert.equal(c.tail, 'た');
  c.input('ka', 'center', (t += 100));
  c.input('ta', 'center', (t += 100));
  assert.equal(c.tail, 'たかた');
  c.input('ta', 'left', (t += 100)); // a flick never toggles
  assert.equal(c.tail, 'たかたち');
  c.input('ta', 'center', (t += 100));
  c.modify(); // resets toggle state
  c.input('ta', 'center', (t += 100));
  assert.equal(c.tail, 'たかたちだた');
});

test('toggle input is off by default settings', () => {
  const c = make();
  c.input('a', 'center', 0);
  c.input('a', 'center', 100);
  assert.equal(c.tail, 'ああ');
});

test('settings normalization keeps known keys with matching types', () => {
  const s = normalizeSettings({ toggleInput: true, flickThreshold: '9', bogus: 1 });
  assert.equal(s.toggleInput, true);
  assert.equal(s.flickThreshold, 24);
  assert.equal('bogus' in s, false);
  assert.equal(normalizeSettings(null).enabled, true);
});
