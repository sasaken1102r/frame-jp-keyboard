import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFlickDirection, DEFAULT_FLICK_THRESHOLD } from '../src/flick.js';

test('measured device flicks', () => {
  assert.equal(getFlickDirection(103, -5), 'right');
  assert.equal(getFlickDirection(-3, -53), 'up');
});

test('tap jitter stays a tap', () => {
  for (const [dx, dy] of [[5, 0], [-8, 6], [0, -12], [9, 9], [0, 0]]) {
    assert.equal(getFlickDirection(dx, dy), 'center', `${dx},${dy}`);
  }
});

test('four directions by angle', () => {
  assert.equal(getFlickDirection(-40, 0), 'left');
  assert.equal(getFlickDirection(40, 0), 'right');
  assert.equal(getFlickDirection(0, -40), 'up');
  assert.equal(getFlickDirection(0, 40), 'down');
  // Slanted flicks resolve to the dominant axis.
  assert.equal(getFlickDirection(30, -20), 'right');
  assert.equal(getFlickDirection(20, -30), 'up');
  assert.equal(getFlickDirection(-30, 25), 'left');
  assert.equal(getFlickDirection(-20, 35), 'down');
});

test('threshold is configurable', () => {
  assert.equal(DEFAULT_FLICK_THRESHOLD, 24);
  assert.equal(getFlickDirection(20, 0), 'center');
  assert.equal(getFlickDirection(20, 0, 15), 'right');
  assert.equal(getFlickDirection(30, 0, 40), 'center');
});

test('invalid input is a tap', () => {
  assert.equal(getFlickDirection(Number.NaN, 5), 'center');
});
