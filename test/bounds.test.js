import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBounds, RESERVED_BOTTOM_PX } from '../src/bounds.js';

test('minimal mode: exactly the stock panel, move bar strip left free', () => {
  assert.deepEqual(computeBounds({ viewportHeight: 280, panel: { top: 0, bottom: 239 } }), { top: 0, bottom: 41 });
});

test('buffered mode: the stock text line above the panel stays visible', () => {
  assert.deepEqual(computeBounds({ viewportHeight: 280, panel: { top: 40, bottom: 239 } }), { top: 40, bottom: 41 });
});

test('odd rects fall back to the popup minus the reserved strip', () => {
  const fallback = { top: 0, bottom: RESERVED_BOTTOM_PX };
  assert.deepEqual(computeBounds({ viewportHeight: 600, panel: { top: -97, bottom: 400 } }), fallback);
  assert.deepEqual(computeBounds({ viewportHeight: 280, panel: { top: 0, bottom: 900 } }), fallback);
  assert.deepEqual(computeBounds({ viewportHeight: 280, panel: { top: 200, bottom: 239 } }), fallback);
  assert.deepEqual(computeBounds({ viewportHeight: 280, panel: { top: NaN, bottom: 239 } }), fallback);
  assert.deepEqual(computeBounds({ viewportHeight: 280, panel: null }), fallback);
});

test('the bottom strip is always reserved, even if the stock panel reaches the bottom', () => {
  assert.deepEqual(computeBounds({ viewportHeight: 280, panel: { top: 0, bottom: 280 } }), { top: 0, bottom: 41 });
});

test('never exceeds the popup, also for tiny or missing viewports', () => {
  for (const viewportHeight of [0, -5, NaN, 50, 100, 280, 600]) {
    for (const panel of [null, { top: -97, bottom: 400 }, { top: 0, bottom: 239 }]) {
      const b = computeBounds({ viewportHeight, panel });
      const h = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
      assert.ok(b.top >= 0 && b.bottom >= 0, JSON.stringify({ viewportHeight, panel, b }));
      assert.ok(b.top + b.bottom <= h, JSON.stringify({ viewportHeight, panel, b }));
    }
  }
});
