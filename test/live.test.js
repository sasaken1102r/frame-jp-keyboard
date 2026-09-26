import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidates, toKatakana, createDebouncer, createGeneration } from '../src/live.js';

test('toKatakana converts hiragana only', () => {
  assert.equal(toKatakana('きょうはー、A漢'), 'キョウハー、A漢');
  assert.equal(toKatakana('ゔぁ'), 'ヴァ');
});

test('merge order: whole, segment, predictions, hiragana, katakana', () => {
  const list = mergeCandidates({
    reading: 'きょうはいいてんき',
    whole: '今日はいい天気',
    segment: ['今日は', '京は', 'きょうは'],
    predictions: ['今日はいい天気です'],
  });
  assert.deepEqual(list.map((c) => [c.text, c.kind, c.index]), [
    ['今日はいい天気', 'whole', -1],
    ['今日は', 'segment', 0],
    ['京は', 'segment', 1],
    ['きょうは', 'segment', 2],
    ['今日はいい天気です', 'prediction', 0],
    ['きょうはいいてんき', 'hiragana', -1],
    ['キョウハイイテンキ', 'katakana', -1],
  ]);
});

test('merge de-duplicates, first occurrence wins, keeps lookup indexes', () => {
  const list = mergeCandidates({
    reading: 'かんじ',
    whole: '漢字',
    segment: ['漢字', '感じ', 'かんじ', 'カンジ'],
    predictions: ['感じ', '漢字検定'],
  });
  assert.deepEqual(list.map((c) => `${c.text}:${c.kind}:${c.index}`), [
    '漢字:whole:-1',
    '感じ:segment:1',
    'かんじ:segment:2',
    'カンジ:segment:3',
    '漢字検定:prediction:1',
  ]);
});

test('merge with nothing from anthy still offers the reading', () => {
  assert.deepEqual(mergeCandidates({ reading: 'ぬ' }).map((c) => c.text), ['ぬ', 'ヌ']);
  assert.deepEqual(mergeCandidates({ reading: '' }), []);
});

/**
 * Manual timers for the debouncer.
 * @returns {{setTimer: Function, clearTimer: Function, runAll: () => void, readonly size: number, delays: number[]}} Fake timers
 * @example
 * const t = fakeTimers();
 */
const fakeTimers = () => {
  const timers = new Map();
  const delays = [];
  let id = 0;
  return {
    setTimer: (fn, ms) => {
      delays.push(ms);
      timers.set(++id, fn);
      return id;
    },
    clearTimer: (key) => timers.delete(key),
    runAll: () => {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((fn) => fn());
    },
    get size() {
      return timers.size;
    },
    delays,
  };
};

test('debouncer: rescheduling replaces the pending call', () => {
  const t = fakeTimers();
  const d = createDebouncer({ delayMs: 150, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const calls = [];
  d.schedule(() => calls.push(1));
  d.schedule(() => calls.push(2));
  d.schedule(() => calls.push(3));
  assert.equal(t.size, 1);
  assert.equal(d.pending, true);
  t.runAll();
  assert.deepEqual(calls, [3]);
  assert.equal(d.pending, false);
  assert.deepEqual(t.delays, [150, 150, 150]);
});

test('debouncer: cancel drops the pending call', () => {
  const t = fakeTimers();
  const d = createDebouncer({ delayMs: 150, setTimer: t.setTimer, clearTimer: t.clearTimer });
  let ran = false;
  d.schedule(() => { ran = true; });
  d.cancel();
  t.runAll();
  assert.equal(ran, false);
  assert.equal(d.pending, false);
});

test('debouncer: real timers fire once after the quiet time', async () => {
  const d = createDebouncer({ delayMs: 20 });
  let count = 0;
  d.schedule(() => { count += 1; });
  await new Promise((r) => setTimeout(r, 5));
  d.schedule(() => { count += 1; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(count, 1);
});

test('generation: stale jobs are detected', () => {
  const g = createGeneration();
  const job = g.current;
  assert.equal(g.isCurrent(job), true);
  g.bump();
  assert.equal(g.isCurrent(job), false);
  assert.equal(g.isCurrent(g.current), true);
});
