import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correctionsFor,
  createDictionary,
  createWordTracker,
  decodeWords,
  edits1,
  matchCase,
  scoredEdits1,
  suggest,
} from '../src/english.js';
import { createComposer } from '../src/composer.js';
import { WORDS_EN } from '../src/data/words-en.js';

const real = createDictionary(decodeWords(WORDS_EN));

/**
 * Suggestion texts.
 * @param {import('../src/english.js').Dictionary} dict - Dictionary
 * @param {string} typed - Typed word
 * @returns {string[]} Texts
 * @example
 * texts(real, 'helo')
 */
const texts = (dict, typed) => suggest(dict, typed).map((s) => s.text);

test('decodeWords: front coding, bands in order, shorter words first within a band', () => {
  assert.deepEqual(decodeWords('0the,1o|0help,3lo,0a'), ['to', 'the', 'a', 'help', 'hello']);
});

test('the bundled list: 40,000 words, common words ranked high', () => {
  assert.equal(decodeWords(WORDS_EN).length, 40000);
  const rank = (w) => real.byLower.get(w).rank;
  assert.ok(rank('the') < 10);
  assert.ok(rank('help') < rank('hello'));
  assert.ok(rank('hello') < rank('keyboard'));
  assert.ok(real.byLower.has('walked')); // regular inflections are included
});

test('completions come first, ranked by frequency, then the typed string', () => {
  const dict = createDictionary(['the', 'they', 'then', 'theory', 'thesaurus']);
  assert.deepEqual(suggest(dict, 'the'), [
    { text: 'they', kind: 'completion' },
    { text: 'then', kind: 'completion' },
    { text: 'theory', kind: 'completion' },
    { text: 'thesaurus', kind: 'completion' },
    { text: 'the', kind: 'typed' },
  ]);
  assert.deepEqual(suggest(dict, ''), []);
});

test('corrections only when completions are few; helo suggests help and hello', () => {
  const list = texts(real, 'helo');
  assert.equal(list[0], 'helo');
  assert.ok(list.includes('help'));
  assert.ok(list.includes('hello'));
  assert.equal(suggest(real, 'helo').find((s) => s.text === 'hello').kind, 'correction');
  // Plenty of completions: no corrections.
  assert.ok(suggest(real, 'th').every((s) => s.kind !== 'correction'));
});

test('typo kinds: doubled letters and swaps beat unrelated substitutions', () => {
  const e = scoredEdits1('helo');
  assert.equal(e.get('hello'), 0);
  assert.equal(e.get('hleo'), 0.5);
  assert.equal(e.get('help'), 1); // o and p are neighbours
  assert.equal(e.get('held'), 2);
  assert.ok(edits1('ab').has('ba'));
  assert.deepEqual(correctionsFor(real, 'thnak').slice(0, 1).map((x) => x.word), ['thank']);
});

test('distance 2 is used when nothing is at distance 1', () => {
  const dict = createDictionary(['receive', 'house']);
  assert.deepEqual(correctionsFor(dict, 'reciev').map((x) => x.word), ['receive']);
});

test('case follows the input', () => {
  assert.equal(matchCase('Hel', 'hello'), 'Hello');
  assert.equal(matchCase('HEL', 'hello'), 'HELLO');
  assert.equal(matchCase('hel', 'hello'), 'hello');
  assert.equal(matchCase('i', 'I'), 'I');
  assert.deepEqual(texts(real, 'Helo').slice(0, 1), ['Helo']);
  assert.ok(texts(real, 'Helo').includes('Hello'));
  assert.ok(texts(real, 'HELO').includes('HELLO'));
  assert.ok(texts(real, 'i').includes('I'));
});

test('tracker follows typed text, backspace and cursor moves', () => {
  const t = createWordTracker();
  assert.equal(t.word, '');
  t.observe([{ text: 'I said hel' }]);
  assert.equal(t.word, 'hel');
  t.observe([{ text: 'lo ' }]);
  assert.equal(t.word, '');
  t.observe([{ key: 'Backspace' }]);
  assert.equal(t.word, 'hello'); // back into the previous word
  t.observe([{ key: 'ArrowLeft' }]);
  assert.equal(t.word, '');
  t.observe([{ key: 'Backspace' }, { text: 'ab' }]);
  assert.equal(t.word, 'ab');
  t.observe([{ text: "don't" }]);
  assert.equal(t.word, "abdon't");
});

test('sentence starts: after . ! ? and a space, or a new line; unknown text is not a start', () => {
  const t = createWordTracker();
  assert.equal(t.sentenceStart, false);
  t.observe([{ text: 'Hi.' }]);
  assert.equal(t.sentenceStart, false);
  t.observe([{ text: ' ' }]);
  assert.equal(t.sentenceStart, true);
  t.observe([{ text: 'w' }]);
  assert.equal(t.sentenceStart, false);
  t.observe([{ key: 'Enter' }]);
  assert.equal(t.sentenceStart, true);
  t.reset();
  assert.equal(t.sentenceStart, false);
});

test('suggestion tap: exactly Backspace x word length, then the word and a space; undo restores', () => {
  const c = createComposer(() => ({ toggleInput: false, toggleTimeoutMs: 800 }));
  const t = createWordTracker();
  const out = [];
  /**
   * Send ops to the fake target and the tracker.
   * @param {object[]} ops - Operations
   * @returns {void}
   * @example
   * push(c.typeText('a'))
   */
  const push = (ops) => {
    out.push(...ops);
    t.observe(ops);
  };
  for (const ch of 'helo') push(c.typeText(ch));
  push(c.replace(Array.from(t.word).length, 'hello '));
  // Simulate a text field.
  let field = '';
  for (const op of out) field = 'text' in op ? field + op.text : field.slice(0, -1);
  assert.equal(field, 'hello ');
  assert.equal(t.word, '');
  assert.deepEqual(c.undo(), [...Array(6)].map(() => ({ key: 'Backspace' })).concat([{ text: 'helo' }]));
});

test('replace sends exactly count backspaces even after the composer forgot its history', () => {
  const c = createComposer(() => ({ toggleInput: false, toggleTimeoutMs: 800 }));
  assert.deepEqual(c.replace(2, 'ok '), [{ key: 'Backspace' }, { key: 'Backspace' }, { text: 'ok ' }]);
  assert.deepEqual(c.replace(0, 'a'), [{ text: 'a' }]);
});
