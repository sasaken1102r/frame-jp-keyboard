import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFlickChar, getFlickCandidates, getToggleSequence, KANA_KEYS } from '../src/kana-table.js';
import { cycleModifier } from '../src/modifiers.js';
import { PAGES } from '../src/layout.js';

const LAYOUT = PAGES.kana;

test('rows follow tap=あ段 left=い up=う right=え down=お', () => {
  const rows = { a: 'あいうえお', ka: 'かきくけこ', sa: 'さしすせそ', ta: 'たちつてと', na: 'なにぬねの', ha: 'はひふへほ', ma: 'まみむめも', ra: 'らりるれろ' };
  for (const [id, kana] of Object.entries(rows)) {
    assert.deepEqual(['center', 'left', 'up', 'right', 'down'].map((d) => getFlickChar(id, d)).join(''), kana, id);
  }
});

test('special rows', () => {
  assert.deepEqual(getFlickCandidates('ya'), { center: 'や', left: '「', up: 'ゆ', right: '」', down: 'よ' });
  assert.deepEqual(getFlickCandidates('wa'), { center: 'わ', left: 'を', up: 'ん', right: 'ー', down: '～' });
  assert.deepEqual(getFlickCandidates('punct'), { center: '、', left: '。', up: '？', right: '！', down: null });
});

test('unknown key or direction', () => {
  assert.equal(getFlickChar('xx', 'center'), null);
  assert.equal(getFlickChar('a', 'diagonal'), null);
  assert.equal(getFlickCandidates('xx'), null);
  assert.deepEqual(getToggleSequence('xx'), []);
});

test('toggle sequences start with the tap character', () => {
  for (const [id, key] of Object.entries(KANA_KEYS)) assert.equal(key.toggle[0], key.flick[0], id);
});

test('゛゜小 cycles', () => {
  const run = (start, n) => {
    const out = [start];
    for (let i = 0; i < n; i++) out.push(cycleModifier(out.at(-1)));
    return out.join('');
  };
  assert.equal(run('か', 2), 'かがか');
  assert.equal(run('は', 3), 'はばぱは');
  assert.equal(run('つ', 3), 'つっづつ');
  assert.equal(run('や', 2), 'やゃや');
  assert.equal(run('う', 3), 'うぅゔう');
  assert.equal(run('ほ', 1), 'ほぼ');
  assert.equal(cycleModifier('ん'), null);
  assert.equal(cycleModifier('ー'), null);
  assert.equal(cycleModifier(undefined), null);
});

test('layout is 5 x 4 with the kana keys in place', () => {
  assert.equal(LAYOUT.length, 4);
  for (const row of LAYOUT) assert.equal(row.length, 5);
  assert.deepEqual(LAYOUT.map((row) => row.map((k) => k.id)), [
    ['undo', 'a', 'ka', 'sa', 'backspace'],
    ['left', 'ta', 'na', 'ha', 'right'],
    ['symbols', 'ma', 'ya', 'ra', 'space'],
    ['mode', 'modify', 'wa', 'punct', 'enter'],
  ]);
});
