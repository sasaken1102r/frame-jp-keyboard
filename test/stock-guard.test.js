import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStockGuard, shouldSwallow, GUARDED_EVENTS } from '../src/stock-guard.js';

/**
 * A minimal event target that keeps capture and bubble listeners apart like a browser window
 * (Node's EventTarget does not remove capture listeners). Capture listeners run first.
 * @returns {{addEventListener: Function, removeEventListener: Function, dispatchEvent: (e: Event) => boolean}} Fake window
 * @example
 * fakeWindow().dispatchEvent(new CustomEvent('vgp_onbuttondown', { cancelable: true }))
 */
const fakeWindow = () => {
  /** @type {{type: string, fn: Function, capture: boolean}[]} */
  const listeners = [];
  return {
    addEventListener: (type, fn, capture = false) => {
      if (!listeners.some((l) => l.type === type && l.fn === fn && l.capture === !!capture)) listeners.push({ type, fn, capture: !!capture });
    },
    removeEventListener: (type, fn, capture = false) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: (e) => {
      let stopped = false;
      const stop = e.stopImmediatePropagation.bind(e);
      e.stopImmediatePropagation = () => { stopped = true; stop(); };
      const ordered = [...listeners.filter((l) => l.capture), ...listeners.filter((l) => !l.capture)];
      for (const l of ordered) {
        if (stopped) break;
        if (l.type === e.type) l.fn(e);
      }
      return !e.defaultPrevented;
    },
  };
};

/**
 * A minimal popup document: a window with listeners and a head that holds style elements.
 * @returns {{doc: object, win: ReturnType<typeof fakeWindow>, styles: object[]}} Fake document, its window and the styles in its head
 * @example
 * const { doc, win, styles } = fakePopup();
 */
const fakePopup = () => {
  const win = fakeWindow();
  const styles = [];
  const head = {
    append: (node) => styles.push(node),
  };
  const doc = {
    defaultView: win,
    head,
    getElementById: (id) => styles.find((s) => s.id === id) ?? null,
    createElement: () => {
      const node = { id: '', textContent: '' };
      node.remove = () => {
        const i = styles.indexOf(node);
        if (i >= 0) styles.splice(i, 1);
      };
      return node;
    },
  };
  return { doc, win, styles };
};

/**
 * Dispatch a gamepad event on the window with a stock-side listener behind it.
 * @param {ReturnType<typeof fakeWindow>} win - Popup window
 * @param {string} type - Event type
 * @param {number} button - Button number
 * @returns {{reached: boolean, notCancelled: boolean}} Whether the stock listener saw it, and dispatchEvent's result
 * @example
 * press(win, 'vgp_onbuttondown', 1)
 */
const press = (win, type, button) => {
  let reached = false;
  /**
   * Stands in for the stock keyboard's handler.
   * @returns {void}
   * @example
   * stock()
   */
  const stock = () => { reached = true; };
  win.addEventListener(type, stock);
  const notCancelled = win.dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable: true, detail: { button, source: 1, is_repeat: false } }));
  win.removeEventListener(type, stock);
  return { reached, notCancelled };
};

test('typing buttons are swallowed: A, X, Y, triggers, bumpers, d-pad, stick and pad clicks', () => {
  for (const button of [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 20, 22]) {
    assert.equal(shouldSwallow('vgp_onbuttondown', { button }), true, `down ${button}`);
    assert.equal(shouldSwallow('vgp_onbuttonup', { button }), true, `up ${button}`);
  }
});

test('B, Select, Start and the Steam buttons stay with Steam', () => {
  for (const button of [2, 13, 14, 27, 28]) {
    assert.equal(shouldSwallow('vgp_onbuttondown', { button }), false, `down ${button}`);
    assert.equal(shouldSwallow('vgp_onbuttonup', { button }), false, `up ${button}`);
  }
  assert.equal(shouldSwallow('vgp_oncancel', { button: 2 }), false);
  assert.equal(shouldSwallow('vgp_onmenu', { button: 14 }), false);
});

test('logical key events are swallowed; unknown buttons are swallowed; other events are not', () => {
  for (const type of ['vgp_onok', 'vgp_onsecondaryaction', 'vgp_onoptions', 'vgp_ondirection']) {
    assert.equal(shouldSwallow(type, { button: 1 }), true, type);
  }
  assert.equal(shouldSwallow('vgp_onbuttondown', { button: 99 }), true);
  assert.equal(shouldSwallow('vgp_onbuttondown', undefined), true);
  for (const type of ['vgp_onfocus', 'vgp_onblur', 'touchstart', 'pointerdown', 'keydown']) {
    assert.equal(shouldSwallow(type, { button: 1 }), false, type);
  }
});

test('GUARDED_EVENTS lists exactly the swallowable event types', () => {
  assert.deepEqual([...GUARDED_EVENTS].sort(), ['vgp_onbuttondown', 'vgp_onbuttonup', 'vgp_ondirection', 'vgp_onok', 'vgp_onoptions', 'vgp_onsecondaryaction']);
});

test('inactive guard changes nothing', () => {
  const { doc, win, styles } = fakePopup();
  const guard = createStockGuard(doc);
  assert.deepEqual(press(win, 'vgp_onbuttondown', 1), { reached: true, notCancelled: true });
  assert.equal(styles.length, 0);
  assert.deepEqual(guard.stats(), { active: false, swallowed: 0 });
});

test('active guard stops A before the stock keyboard, lets B through and hides the stock panel', () => {
  const { doc, win, styles } = fakePopup();
  const guard = createStockGuard(doc);
  guard.setActive(true);
  assert.deepEqual(press(win, 'vgp_onbuttondown', 1), { reached: false, notCancelled: false });
  assert.deepEqual(press(win, 'vgp_onbuttonup', 1), { reached: false, notCancelled: false });
  assert.deepEqual(press(win, 'vgp_onbuttondown', 8), { reached: false, notCancelled: false });
  assert.deepEqual(press(win, 'vgp_onbuttondown', 2), { reached: true, notCancelled: true });
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /opacity: 0/);
  assert.match(styles[0].textContent, /pointer-events: none/);
  assert.deepEqual(guard.stats(), { active: true, swallowed: 3 });
});

test('setActive is idempotent and disabling restores everything', () => {
  const { doc, win, styles } = fakePopup();
  const guard = createStockGuard(doc);
  guard.setActive(true);
  guard.setActive(true);
  assert.equal(styles.length, 1);
  guard.setActive(false);
  assert.equal(styles.length, 0);
  assert.deepEqual(press(win, 'vgp_onbuttondown', 1), { reached: true, notCancelled: true });
  guard.setActive(true);
  assert.deepEqual(press(win, 'vgp_onbuttondown', 1), { reached: false, notCancelled: false });
  guard.destroy();
  assert.equal(styles.length, 0);
  assert.deepEqual(press(win, 'vgp_onbuttondown', 1), { reached: true, notCancelled: true });
  assert.equal(guard.stats().active, false);
});

test('a style left by an earlier instance is replaced, not duplicated', () => {
  const { doc, styles } = fakePopup();
  const old = createStockGuard(doc);
  old.setActive(true);
  const fresh = createStockGuard(doc);
  fresh.setActive(true);
  assert.equal(styles.length, 1);
  fresh.destroy();
  assert.equal(styles.length, 0);
});

test('a popup that is already gone does not throw', () => {
  const guard = createStockGuard({
    defaultView: null,
    addEventListener: () => { throw new Error('dead'); },
    removeEventListener: () => { throw new Error('dead'); },
  });
  assert.doesNotThrow(() => guard.setActive(true));
  assert.doesNotThrow(() => guard.destroy());
});
