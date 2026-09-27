import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCursorTracker, CURSOR_TOLERANCE_PX, EVENT_WINDOW_MS } from '../src/cursor-tracker.js';

test('the pressing cursor is the active one nearest to the touch', () => {
  const t = createCursorTracker();
  t.update(0, true, 100, 100); // left hand
  t.update(1, true, 600, 120); // right hand
  assert.equal(t.pick(598, 121).index, 1);
  assert.equal(t.pick(103, 99).index, 0);
});

test('inactive cursors and cursors farther than the tolerance are not picked', () => {
  const t = createCursorTracker();
  t.update(0, true, 100, 100);
  t.update(0, false, 0, 0); // left the popup
  t.update(1, true, 600, 120);
  assert.equal(t.pick(101, 100), null);
  assert.equal(t.pick(600 + CURSOR_TOLERANCE_PX + 5, 120), null);
  assert.equal(t.position(0).active, false);
  assert.equal(t.position(0).x, 100); // last position kept
});

test('a device-pixel cursor space is detected and kept (dpr 1.5)', () => {
  const t = createCursorTracker({ scales: [1, 1 / 1.5, 1.5] });
  t.update(1, true, 900, 180); // device px for client (600, 120)
  const picked = t.pick(600, 120);
  assert.equal(picked.index, 1);
  assert.equal(picked.scale, 1 / 1.5);
  assert.equal(t.scale, 1 / 1.5);
  t.update(0, true, 150, 150); // client (100, 100)
  assert.equal(t.pick(100, 100).index, 0);
});

test('snapshot lists cursors as numbers only', () => {
  const t = createCursorTracker();
  t.update(1, true, 10.4, 20.6);
  assert.deepEqual(t.snapshot(), [{ index: 1, active: true, x: 10, y: 21 }]);
});

test('the press marker (index, false, 0, 0) names the pressing laser, within the event window', () => {
  let clock = 1000;
  const t = createCursorTracker({ now: () => clock });
  t.update(1, true, 600, 120); // focused laser streams
  t.update(0, false, 0, 0); // the other laser announces its press
  clock += 3;
  assert.equal(t.pressingIndex(), 0);
  assert.equal(t.pressingIndex(clock + EVENT_WINDOW_MS + 10), null);
});

test('the release event (index, false, x, y) gives the end point of that laser only', () => {
  let clock = 5000;
  const t = createCursorTracker({ now: () => clock });
  t.update(0, false, 0, 0);
  clock += 400;
  t.update(0, false, 632, -100); // released above the key: an up flick
  clock += 1;
  assert.deepEqual(t.releasePoint(0), { x: 632, y: -100 });
  assert.equal(t.releasePoint(1), null);
  assert.equal(t.releasePoint(0, clock + EVENT_WINDOW_MS + 1), null);
});
