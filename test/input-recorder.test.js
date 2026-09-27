import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputRecorder } from '../src/input-recorder.js';

test('logs one window per press: 300 ms before touchstart to 300 ms after touchend, numbers only', () => {
  let t = 0;
  const windows = [];
  const timers = [];
  const rec = createInputRecorder({ onWindow: (w) => windows.push(w), now: () => t, setTimer: (fn) => timers.push(fn) });
  const touch = (type, x, y, touches) => ({ type, changedTouches: [{ identifier: 3, clientX: x, clientY: y }], touches: { length: touches } });
  t = 0; rec.cursor(1, true, 10, 10); // too early
  t = 800; rec.cursor(1, true, 100.26, 50);
  t = 1000; rec.touch(touch('touchstart', 100, 50, 1));
  t = 1010; rec.cursor(1, false, 0, 0);
  t = 1050; rec.pointer({ type: 'pointermove', pointerType: 'touch', pointerId: 7, clientX: 101, clientY: 49, buttons: 1 });
  t = 1200; rec.touch(touch('touchend', 100, 50, 0));
  t = 1400; rec.cursor(0, true, 5, 5);
  t = 1600; rec.cursor(0, true, 6, 6); // too late
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].entries, [
    ['c', -200, 1, true, 100.3, 50],
    ['t', 0, 's', 3, 100, 50, 1],
    ['c', 10, 1, false, 0, 0],
    ['p', 50, 'm', 'touch', 7, 101, 49, 1],
    ['t', 200, 'e', 3, 100, 50, 0],
    ['c', 400, 0, true, 5, 5],
  ]);
  assert.equal(windows[0].press, 1);
});
