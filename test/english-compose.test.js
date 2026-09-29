import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnglishComposition, isWordChar } from '../src/english-compose.js';

/**
 * Type letters into a composition.
 * @param {ReturnType<typeof createEnglishComposition>} en - Composition
 * @param {string} text - Letters
 * @returns {void}
 * @example
 * typeInto(en, 'hi')
 */
const typeInto = (en, text) => {
  for (const ch of text) en.input(ch);
};

test('letters compose locally; nothing is sent until a commit', () => {
  const en = createEnglishComposition();
  typeInto(en, 'helo');
  assert.equal(en.word, 'helo');
  assert.equal(en.caret, 4);
});

test('space, punctuation and ⏎ commit the word followed by that character (⏎ adds nothing)', () => {
  const en = createEnglishComposition();
  typeInto(en, 'hi');
  assert.deepEqual(en.commit(' '), [{ text: 'hi ' }]);
  typeInto(en, 'there');
  assert.deepEqual(en.commit('.'), [{ text: 'there.' }]);
  typeInto(en, 'ok');
  assert.deepEqual(en.commit(), [{ text: 'ok' }]);
  assert.equal(en.word, '');
  assert.deepEqual(en.commit(), []);
  assert.deepEqual(en.commit('!'), [{ text: '!' }]);
});

test('a suggestion replaces the word and adds a space', () => {
  const en = createEnglishComposition();
  typeInto(en, 'helo');
  assert.deepEqual(en.commitAs('hello'), [{ text: 'hello ' }]);
  assert.equal(en.word, '');
});

test('⌫ and ←→ edit the composition, and pass through when it is empty', () => {
  const en = createEnglishComposition();
  typeInto(en, 'abc');
  assert.deepEqual(en.backspace(), []);
  assert.equal(en.word, 'ab');
  assert.deepEqual(en.arrow('left'), []);
  en.input('x');
  assert.equal(en.word, 'axb');
  assert.deepEqual(en.arrow('right'), []);
  assert.deepEqual(en.arrow('right'), []); // clamped at the end
  assert.equal(en.caret, 3);
  en.commit();
  assert.deepEqual(en.backspace(), [{ key: 'Backspace' }]);
  assert.deepEqual(en.arrow('left'), [{ key: 'ArrowLeft' }]);
  assert.deepEqual(en.arrow('right'), [{ key: 'ArrowRight' }]);
});

test('⌫ at the start of the composition changes nothing', () => {
  const en = createEnglishComposition();
  typeInto(en, 'ab');
  en.arrow('left');
  en.arrow('left');
  assert.deepEqual(en.backspace(), []);
  assert.equal(en.word, 'ab');
});

test('the apostrophe belongs to the word; other symbols do not', () => {
  assert.equal(isWordChar("'"), true);
  assert.equal(isWordChar('a'), true);
  for (const ch of ['.', ',', ' ', '1', '!', '?', '-']) assert.equal(isWordChar(ch), false, ch);
});

test('english compose: Esc (cancel) drops the word without output', () => {
  const c = createEnglishComposition();
  c.input('h');
  c.input('i');
  c.cancel();
  assert.equal(c.word, '');
  assert.equal(c.caret, 0);
  assert.deepEqual(c.commit(), []);
});
