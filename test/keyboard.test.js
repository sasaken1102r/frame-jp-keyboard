import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShift } from '../src/shift.js';
import { createKeyboardState, toMode } from '../src/keyboard-state.js';
import { PAGES, SYMBOLS_1, SYMBOLS_2 } from '../src/layout.js';
import { normalizeSettings } from '../src/settings.js';

test('shift: tap once is one capital', () => {
  const s = createShift();
  assert.equal(s.tap(0), 'once');
  assert.equal(s.apply('a'), 'A');
  assert.equal(s.state, 'off');
  assert.equal(s.apply('b'), 'b');
});

test('shift: double tap locks, tap again unlocks', () => {
  const s = createShift();
  s.tap(1000);
  assert.equal(s.tap(1200), 'lock');
  assert.equal(s.apply('a'), 'A');
  assert.equal(s.apply('b'), 'B');
  assert.equal(s.tap(5000), 'off');
});

test('shift: a slow second tap turns shift off', () => {
  const s = createShift();
  s.tap(0);
  assert.equal(s.tap(2000), 'off');
});

test('pages: あA toggles modes, temporary pages go back', () => {
  const p = createKeyboardState('kana');
  assert.equal(p.page, 'kana');
  p.show('sym1');
  assert.equal(p.back(), 'kana');
  assert.equal(p.toggleMode(), 'qwerty');
  assert.equal(p.page, 'qwerty');
  p.show('num');
  p.show('num2');
  assert.equal(p.back(), 'qwerty');
  p.show('sym2');
  assert.equal(p.toggleMode(), 'kana');
  assert.equal(p.page, 'kana');
  assert.equal(toMode('nonsense'), 'kana');
  assert.equal(createKeyboardState('qwerty').page, 'qwerty');
});

test('layouts: every page has 4 rows and symbol pages are full', () => {
  for (const [id, rows] of Object.entries(PAGES)) {
    assert.equal(rows.length, 4, id);
    for (const row of rows) {
      for (const key of row) assert.ok(key.w > 0, `${id} ${key.id}`);
    }
  }
  assert.equal(SYMBOLS_1.length, 32);
  assert.equal(SYMBOLS_2.length, 32);
  for (const ch of '「」『』・…ー〜！？：；（）') assert.ok(SYMBOLS_1.includes(ch), ch);
  for (const ch of '＠＃％＆＊＋＝／￥') assert.ok([...SYMBOLS_1, ...SYMBOLS_2].includes(ch), ch);
});

test('layouts: every page can reach あA and the kana page matches the design', () => {
  for (const [id, rows] of Object.entries(PAGES)) {
    assert.ok(rows.flat().some((k) => k.id === 'mode' && k.long === 'stock'), id);
  }
  const labels = PAGES.kana.map((row) => row.map((k) => k.label).join(' '));
  assert.deepEqual(labels, [
    '↶ あ か さ ⌫',
    '← た な は →',
    '☺記 ま や ら 空白',
    'あA ゛゜小 わ 、。?! ⏎',
  ]);
});

test('settings: mode is validated and conversion defaults on', () => {
  assert.equal(normalizeSettings({ mode: 'qwerty' }).mode, 'qwerty');
  assert.equal(normalizeSettings({ mode: 'x' }).mode, 'kana');
  assert.equal(normalizeSettings({}).conversion, true);
});
