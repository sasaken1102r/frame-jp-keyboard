import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIPBOARD_CHORDS, MODIFIER_CODES, createModifiers, keyForChar, keyForName, planChord } from '../src/key-chords.js';
import { planCalls } from '../src/output-plan.js';
import { releaseHeldKeys, sendKeyEvents } from '../src/steam.js';
import { PAGES } from '../src/layout.js';

test('chords: letters, digits and US punctuation map to their keys', () => {
  assert.deepEqual(keyForChar('a'), { code: 4, shift: false });
  assert.deepEqual(keyForChar('z'), { code: 29, shift: false });
  assert.deepEqual(keyForChar('Z'), { code: 29, shift: true });
  assert.deepEqual(keyForChar('1'), { code: 30, shift: false });
  assert.deepEqual(keyForChar('0'), { code: 39, shift: false });
  assert.deepEqual(keyForChar('!'), { code: 30, shift: true });
  assert.deepEqual(keyForChar('/'), { code: 56, shift: false });
  assert.deepEqual(keyForChar('?'), { code: 56, shift: true });
  assert.equal(keyForChar('€'), null);
  assert.equal(keyForChar('あ'), null);
  assert.equal(keyForChar('ab'), null);
  assert.deepEqual(keyForName('Escape'), { code: 41, shift: false });
  assert.equal(keyForName('toString'), null);
});

test('chords: modifiers go down first and up last, in reverse order', () => {
  const { ctrl, alt, shift } = MODIFIER_CODES;
  assert.deepEqual(planChord({ ctrl: true }, keyForChar(CLIPBOARD_CHORDS.copy)), [[ctrl, true], [6, true], [6, false], [ctrl, false]]);
  assert.deepEqual(planChord({ ctrl: true, alt: true, shift: true }, keyForChar('t')), [
    [ctrl, true], [alt, true], [shift, true], [23, true], [23, false], [shift, false], [alt, false], [ctrl, false],
  ]);
  assert.deepEqual(planChord({}, keyForName('Escape')), [[41, true], [41, false]]);
});

test('chords: a shifted character adds Shift even when Shift is not lit', () => {
  const { ctrl, shift } = MODIFIER_CODES;
  assert.deepEqual(planChord({ ctrl: true }, keyForChar('?')), [[ctrl, true], [shift, true], [56, true], [56, false], [shift, false], [ctrl, false]]);
});

test('chords: every planned chord releases every key it presses', () => {
  for (const held of [{}, { ctrl: true }, { alt: true }, { ctrl: true, alt: true, shift: true }]) {
    const down = new Set();
    for (const [code, isDown] of planChord(held, keyForChar('A'))) {
      if (isDown) down.add(code);
      else down.delete(code);
    }
    assert.equal(down.size, 0);
  }
});

test('modifiers: tap arms, tap again cancels, and the next key takes them once', () => {
  const mods = createModifiers();
  assert.equal(mods.active, false);
  mods.toggle('ctrl');
  assert.equal(mods.ctrl, true);
  mods.toggle('ctrl');
  assert.equal(mods.active, false);
  mods.toggle('ctrl');
  mods.toggle('alt');
  assert.deepEqual(mods.take(), { ctrl: true, alt: true });
  assert.equal(mods.active, false);
  assert.deepEqual(mods.take(), { ctrl: false, alt: false });
  mods.toggle('alt');
  mods.clear();
  assert.equal(mods.active, false);
});

test('output: chords pass through the call plan in order', () => {
  const keys = planChord({ ctrl: true }, keyForChar('v'));
  assert.deepEqual(planCalls([{ text: 'ab' }, { keys }, { key: 'Enter' }], { buffered: false }), ['a', 'b', { keys }, 'Enter']);
});

test('output: a failing key-state call still releases every pressed key', () => {
  const calls = [];
  globalThis.SteamClient = {
    Input: {
      ControllerKeyboardSetKeyState: (code, down) => {
        calls.push([code, down]);
        if (code === 6 && down) throw new Error('boom');
      },
    },
  };
  try {
    const ok = sendKeyEvents(planChord({ ctrl: true, alt: true }, keyForChar('c')));
    assert.equal(ok, false);
    // Ctrl and Alt down, C down (throws), then C, Alt, Ctrl released.
    assert.deepEqual(calls, [[103, true], [100, true], [6, true], [6, false], [100, false], [103, false]]);
    calls.length = 0;
    releaseHeldKeys();
    assert.deepEqual(calls, []);
    assert.equal(sendKeyEvents(planChord({}, keyForName('Escape'))), true);
    assert.deepEqual(calls, [[41, true], [41, false]]);
  } finally {
    delete globalThis.SteamClient;
  }
});

test('output: without the key-state call a chord is dropped, never typed', () => {
  assert.equal(sendKeyEvents(planChord({ ctrl: true }, keyForChar('v'))), false);
});

test('layout: QWERTY is arranged like a PC keyboard', () => {
  const [top, home, lower, bottom] = PAGES.qwerty;
  const ids = (row) => row.map((k) => k.id);
  assert.deepEqual(ids(top), ['esc', ...'qwertyuiop', 'backspace']);
  assert.deepEqual(ids(home), ['', ...'asdfghjkl', 'enter']);
  assert.deepEqual(ids(lower), ['shift', ...'zxcvbnm', ',', '.', 'shift']);
  assert.deepEqual(ids(bottom), ['ctrl', 'alt', 'num', 'space', 'mode', 'left', 'right']);
  assert.equal(bottom.find((k) => k.id === 'mode').long, 'stock');
  // Letters are all the same width, and every row adds up to the same total.
  assert.ok(PAGES.qwerty.flat().filter((k) => k.letter).every((k) => k.w === 1));
  const width = (row) => row.reduce((sum, k) => sum + k.w, 0);
  for (const row of PAGES.qwerty) assert.ok(Math.abs(width(row) - width(top)) < 1e-9);
});

test('layout: the number pages keep ⌫, ⏎ and the bottom row where QWERTY has them', () => {
  /**
   * Left edge and width of the key with an id in a row, in key widths.
   * @param {object[]} row - Row
   * @param {string} id - Key id
   * @returns {[number, number]} Start and width
   * @example
   * span(row, 'enter')
   */
  const span = (row, id) => {
    const i = row.findIndex((k) => k.id === id);
    return [row.slice(0, i).reduce((sum, k) => sum + k.w, 0), row[i].w].map((v) => Math.round(v * 1000) / 1000);
  };
  const [top, home, , bottom] = PAGES.qwerty;
  for (const id of ['num', 'num2']) {
    const [nTop, nHome, , nBottom] = PAGES[id];
    assert.deepEqual(span(nTop, 'backspace'), span(top, 'backspace'), id);
    assert.deepEqual(span(nHome, 'enter'), span(home, 'enter'), id);
    assert.deepEqual(nBottom.map((k) => [k.id === 'qwerty' ? 'num' : k.id, k.w]), bottom.map((k) => [k.id, k.w]), id);
  }
});
