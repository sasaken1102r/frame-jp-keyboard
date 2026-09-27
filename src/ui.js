// DOM layer: our keyboard, drawn inside the stock VR keyboard popup's document.
//
// Input notes (measured on the device, 2026-09-26): the VR laser arrives as touch events
// (touchstart -> touchmove ~90 Hz -> touchend, coordinates in changedTouches[0]). With the default
// touch-action the browser pans and fires pointercancel, so everything here is touch-action:none
// and we listen to touch events. Mouse pointer events are a fallback for desktop debugging.
// Because default panning is off, the candidate panel is scrolled by our own drag handling.
//
// Layout: on the kana page the panel is split horizontally, with the composition panel on the left
// (preedit line, then a wrapping candidate grid that scrolls vertically) and the 12-key flick pad on
// the right, using the full height. QWERTY, numbers and symbols use the full width; the QWERTY and
// number pages get a one-row English suggestion strip above the keys.
import { getFlickDirection, DIRECTIONS } from './flick.js';
import { createIcon, hasIcon } from './icons.js';
import { getFlickCandidates } from './kana-table.js';
import { PAGES } from './layout.js';
import { OVERLAY_CSS } from './styles.js';

const HOST_ID = 'fjk-host';
const REPEAT_DELAY_MS = 450;
const REPEAT_INTERVAL_MS = 70;
const LONG_PRESS_MS = 550;
/** English suggestions shown in the strip. */
const MAX_SUGGESTIONS = 6;
/** Movement (CSS px) below which a press on the candidate bar is a tap rather than a scroll. */
const BAR_TAP_SLOP = 12;
/** Ignore mouse presses this soon after a touch, in case the platform also emits mouse events. */
const MOUSE_AFTER_TOUCH_MS = 600;

/** Cell offsets of the flick guide, in key sizes. */
const GUIDE_OFFSETS = Object.freeze({
  center: [0, 0],
  left: [-1, 0],
  up: [0, -1],
  right: [1, 0],
  down: [0, 1],
});

/**
 * Clamp a number into a range.
 * @param {number} value - Value
 * @param {number} min - Lower bound
 * @param {number} max - Upper bound (wins when smaller than min)
 * @returns {number} Clamped value
 * @example
 * clamp(5, 0, 3) // 3
 */
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Create an element in the given document with a class and optional text.
 * @param {Document} doc - Owner document (the popup's, not SharedJSContext's)
 * @param {string} tag - Tag name
 * @param {string} className - Class name(s)
 * @param {string} [text] - Text content
 * @returns {HTMLElement} The element
 * @example
 * el(doc, 'div', 'fjk-key', 'あ')
 */
const el = (doc, tag, className, text) => {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Find the closest ancestor matching a selector. The popup is another window (realm), so
 * `instanceof Element` would be false; duck-type instead.
 * @param {EventTarget|null} target - Event target
 * @param {string} selector - CSS selector
 * @returns {HTMLElement|null} The element, or null
 * @example
 * closest(event.target, '.fjk-key')
 */
const closest = (target, selector) => (typeof target?.closest === 'function' ? target.closest(selector) : null);

/**
 * @typedef {import('./layout.js').KeyDef} KeyDef
 * @typedef {import('./ime.js').ImeView} ImeView
 * @typedef {import('./keyboard-state.js').PageId} PageId
 */

/**
 * @typedef {object} OverlayHandlers
 * @property {() => {flickThreshold: number}} getSettings - Current settings
 * @property {(keyId: string, direction: string) => void} onKana - A kana key was tapped or flicked
 * @property {(def: KeyDef, direction: string) => void} onChar - A character key was tapped or flicked
 * @property {(actionId: string) => void} onAction - An action key fired (also "stock" from the bar button)
 * @property {(index: number) => void} onCandidate - A candidate was tapped
 * @property {(index: number) => void} onSuggestion - An English suggestion was tapped
 * @property {() => void} onEnable - The re-enable button was pressed
 * @property {() => void} onUpdateTap - The update indicator dot was tapped (forces a check)
 * @property {(action: 'yes'|'no'|'dismiss') => void} onUpdateAction - A button in the update banner was pressed
 */

/**
 * @typedef {object} RenderState
 * @property {PageId} page - Page to show
 * @property {'kana'|'qwerty'} mode - Current mode
 * @property {'off'|'once'|'lock'} shift - Shift state
 * @property {ImeView} view - Composition to show in the candidate bar
 * @property {import('./english.js').Suggestion[]} [suggestions] - English suggestions (QWERTY pages)
 * @property {import('./update.js').UpdateView} [update] - Update indicator state (see update.js)
 */

/**
 * @typedef {object} Overlay
 * @property {HTMLElement} host - Shadow host element in the popup document
 * @property {(enabled: boolean) => void} setEnabled - Show our keyboard, or only the re-enable button
 * @property {(bounds: {top: number, bottom: number}) => void} setBounds - Move the overlay's top and bottom edges (CSS px from each edge)
 * @property {(state: RenderState) => void} render - Show a page, labels and the candidate bar
 * @property {() => void} cancelGesture - Abort any press in progress
 * @property {() => object} measure - Rects of the overlay's parts (debug)
 * @property {() => void} destroy - Remove everything from the popup
 */

/**
 * Mount our keyboard into the stock keyboard popup document, above Steam's keyboard.
 * @param {Document} doc - The popup's document
 * @param {OverlayHandlers} handlers - Callbacks
 * @returns {Overlay} The mounted overlay
 * @example
 * const overlay = mountOverlay(popupWindow.document, handlers);
 * overlay.render({ page: 'kana', mode: 'kana', shift: 'off', view });
 */
export const mountOverlay = (doc, handlers) => {
  doc.getElementById(HOST_ID)?.remove();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_CSS;

  const root = el(doc, 'div', 'fjk-root');
  const mainEl = el(doc, 'div', 'fjk-main');
  const leftEl = el(doc, 'div', 'fjk-left fjk-candbar');
  const topline = el(doc, 'div', 'fjk-topline');
  const preeditEl = el(doc, 'div', 'fjk-preedit');
  const stockEl = el(doc, 'div', 'fjk-stock', 'Steam ⌨');
  stockEl.title = 'Steam の純正キーボードに切り替え';
  const updateEl = el(doc, 'div', 'fjk-update');
  topline.append(preeditEl, updateEl, stockEl);
  const candsEl = el(doc, 'div', 'fjk-cands');
  const placeholderEl = el(doc, 'div', 'fjk-placeholder');
  leftEl.append(topline, candsEl, placeholderEl);
  const rightEl = el(doc, 'div', 'fjk-right');
  const suggestEl = el(doc, 'div', 'fjk-suggest fjk-candbar');
  const suggListEl = el(doc, 'div', 'fjk-sugg-list');
  const suggUpdateEl = el(doc, 'div', 'fjk-update');
  const suggStockEl = el(doc, 'div', 'fjk-stock', 'Steam ⌨');
  suggStockEl.title = 'Steam の純正キーボードに切り替え';
  suggestEl.append(suggListEl, suggUpdateEl, suggStockEl);
  const pagesEl = el(doc, 'div', 'fjk-pages');
  rightEl.append(suggestEl, pagesEl);
  mainEl.append(leftEl, rightEl);
  const guide = el(doc, 'div', 'fjk-guide');
  guide.hidden = true;
  const updateBanner = el(doc, 'div', 'fjk-update-banner');
  updateBanner.hidden = true;
  const reenable = el(doc, 'div', 'fjk-reenable', 'あ');
  reenable.title = 'frame-jp-keyboard';

  root.append(mainEl, guide, updateBanner);
  shadow.append(style, root, reenable);

  /** @type {WeakMap<Element, KeyDef>} */
  const keyDefs = new WeakMap();
  /** @type {Map<PageId, {el: HTMLElement, keys: {el: HTMLElement, def: KeyDef, main: HTMLElement}[]}>} */
  const builtPages = new Map();

  /**
   * Build one page's DOM (once).
   * @param {PageId} pageId - Page id
   * @returns {{el: HTMLElement, keys: {el: HTMLElement, def: KeyDef, main: HTMLElement}[]}} The page
   * @example
   * buildPage('qwerty')
   */
  const buildPage = (pageId) => {
    const existing = builtPages.get(pageId);
    if (existing) return existing;
    const pageEl = el(doc, 'div', `fjk-page fjk-page-${pageId}`);
    const keys = [];
    for (const row of PAGES[pageId]) {
      const rowEl = el(doc, 'div', 'fjk-row');
      for (const def of row) {
        if (def.type === 'spacer') {
          const gap = el(doc, 'div', 'fjk-spacer');
          gap.style.flexGrow = String(def.w);
          rowEl.append(gap);
          continue;
        }
        const classes = ['fjk-key', `fjk-${def.type}`];
        if (def.side) classes.push('fjk-side');
        if (def.symbol) classes.push('fjk-symbol');
        const keyEl = el(doc, 'div', classes.join(' '));
        keyEl.style.flexGrow = String(def.w);
        keyEl.dataset.fjkId = def.id;
        const icon = def.type === 'action' && hasIcon(def.id);
        const main = el(doc, 'span', 'fjk-label', def.id === 'mode' || icon ? undefined : def.label);
        if (def.id === 'mode') {
          // "あA" with the current mode's half highlighted (see render()).
          main.append(el(doc, 'span', 'fjk-m-kana', 'あ'), el(doc, 'span', 'fjk-m-en', 'A'));
        } else if (icon) {
          main.append(createIcon(doc, def.id));
        }
        keyEl.append(main);
        if (def.up) keyEl.append(el(doc, 'span', 'fjk-up', def.up));
        keyDefs.set(keyEl, def);
        keys.push({ el: keyEl, def, main });
        rowEl.append(keyEl);
      }
      pageEl.append(rowEl);
    }
    pageEl.hidden = true;
    pagesEl.append(pageEl);
    const page = { el: pageEl, keys };
    builtPages.set(pageId, page);
    return page;
  };

  /** @type {Record<string, HTMLElement>} */
  const cells = Object.fromEntries(DIRECTIONS.map((dir) => {
    const cell = el(doc, 'div', 'fjk-cell');
    guide.append(cell);
    return [dir, cell];
  }));

  /**
   * @typedef {object} Gesture
   * @property {'touch'|'mouse'} source - Input kind
   * @property {number} id - Touch identifier or pointer id
   * @property {'key'|'bar'} kind - A key press, or a press on the candidate panel
   * @property {number} x0 - Start X
   * @property {number} y0 - Start Y
   * @property {HTMLElement|null} keyEl - Pressed key element
   * @property {KeyDef|null} def - Pressed key definition
   * @property {HTMLElement|null} barTarget - Candidate or button pressed on the panel
   * @property {number} scroll0 - Candidate grid scroll position at the start
   * @property {string} dir - Current direction
   * @property {number|undefined} timer - Auto-repeat or long-press timer
   * @property {boolean} fired - Auto-repeat or long press already fired
   */
  /** @type {Gesture|null} */
  let gesture = null;
  let lastTouchTime = 0;
  /** @type {RenderState|null} */
  let current = null;

  /**
   * Show the flick guide around a key: the five kana of a kana key, or the tap and flick-up
   * characters of a character key.
   * @param {HTMLElement} keyEl - The pressed key
   * @param {KeyDef} def - Its definition
   * @returns {void}
   * @example
   * showGuide(keyEl, def)
   */
  const showGuide = (keyEl, def) => {
    let candidates;
    if (def.type === 'kana') {
      candidates = getFlickCandidates(def.id);
    } else if (def.type === 'char') {
      const main = keyEl.querySelector('.fjk-label')?.textContent ?? def.label;
      candidates = { center: main, left: null, up: def.up ?? null, right: null, down: null };
    }
    if (!candidates) return;
    const sparse = def.type !== 'kana';
    const rootRect = root.getBoundingClientRect();
    const keyRect = keyEl.getBoundingClientRect();
    const step = Math.min(keyRect.width, keyRect.height);
    const cellSize = step * 0.94;
    // Keep the whole cross inside the overlay; it only shows candidates, it does not affect detection.
    const margin = sparse ? step * 0.5 : step * 1.5;
    const cx = clamp(keyRect.left + keyRect.width / 2 - rootRect.left, margin, rootRect.width - margin);
    const cy = clamp(keyRect.top + keyRect.height / 2 - rootRect.top, step * 1.5, rootRect.height - (sparse ? step * 0.5 : step * 1.5));
    for (const dir of DIRECTIONS) {
      const cell = cells[dir];
      const [ox, oy] = GUIDE_OFFSETS[dir];
      const ch = candidates[dir];
      cell.textContent = ch ?? '';
      cell.style.fontSize = `${Math.round(cellSize * 0.62)}px`;
      cell.hidden = sparse && !ch;
      cell.classList.toggle('fjk-empty', !ch);
      cell.classList.toggle('fjk-active', dir === 'center');
      Object.assign(cell.style, {
        width: `${cellSize}px`,
        height: `${cellSize}px`,
        left: `${cx + ox * step - cellSize / 2}px`,
        top: `${cy + oy * step - cellSize / 2}px`,
      });
    }
    guide.hidden = false;
  };

  /**
   * Highlight the guide cell of the current direction.
   * @param {string} dir - Direction
   * @returns {void}
   * @example
   * highlightGuide('left')
   */
  const highlightGuide = (dir) => {
    for (const d of DIRECTIONS) cells[d].classList.toggle('fjk-active', d === dir);
  };

  /**
   * End the current gesture without firing anything.
   * @returns {void}
   * @example
   * cancelGesture()
   */
  const cancelGesture = () => {
    if (!gesture) return;
    clearTimeout(gesture.timer);
    clearInterval(gesture.timer);
    gesture.keyEl?.classList.remove('fjk-pressed');
    gesture.barTarget?.classList.remove('fjk-pressed');
    guide.hidden = true;
    gesture = null;
  };

  /**
   * Start a press on a key or on the candidate bar.
   * @param {EventTarget|null} target - Event target (inside the shadow root)
   * @param {number} x - Client X
   * @param {number} y - Client Y
   * @param {'touch'|'mouse'} source - Input kind
   * @param {number} id - Touch identifier or pointer id
   * @returns {boolean} Whether something was pressed
   * @example
   * startGesture(event.target, 10, 20, 'touch', 0)
   */
  const startGesture = (target, x, y, source, id) => {
    const base = { source, id, x0: x, y0: y, dir: 'center', timer: undefined, fired: false };
    if (closest(target, '.fjk-candbar')) {
      cancelGesture();
      const barTarget = closest(target, '.fjk-cand') ?? closest(target, '.fjk-sugg')
        ?? closest(target, '.fjk-update') ?? closest(target, '.fjk-stock');
      gesture = { ...base, kind: 'bar', keyEl: null, def: null, barTarget, scroll0: candsEl.scrollTop };
      barTarget?.classList.add('fjk-pressed');
      return true;
    }
    const keyEl = closest(target, '.fjk-key');
    const def = keyEl ? keyDefs.get(keyEl) : undefined;
    if (!keyEl || !def) return false;
    cancelGesture();
    gesture = { ...base, kind: 'key', keyEl, def, barTarget: null, scroll0: 0 };
    keyEl.classList.add('fjk-pressed');
    if (def.type === 'kana' || def.type === 'char') showGuide(keyEl, def);
    const g = gesture;
    if (def.repeat) {
      g.timer = setTimeout(() => {
        g.fired = true;
        handlers.onAction(def.id);
        g.timer = setInterval(() => handlers.onAction(def.id), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    } else if (def.long) {
      g.timer = setTimeout(() => {
        g.fired = true;
        keyEl.classList.add('fjk-long');
        setTimeout(() => keyEl.classList.remove('fjk-long'), 250);
        handlers.onAction(def.long);
      }, LONG_PRESS_MS);
    }
    return true;
  };

  /**
   * Track movement of the current press.
   * @param {number} x - Client X
   * @param {number} y - Client Y
   * @returns {void}
   * @example
   * moveGesture(40, 20)
   */
  const moveGesture = (x, y) => {
    if (!gesture) return;
    if (gesture.kind === 'bar') {
      candsEl.scrollTop = gesture.scroll0 - (y - gesture.y0);
      if (Math.hypot(x - gesture.x0, y - gesture.y0) >= BAR_TAP_SLOP) gesture.barTarget?.classList.remove('fjk-pressed');
      return;
    }
    const dir = getFlickDirection(x - gesture.x0, y - gesture.y0, handlers.getSettings().flickThreshold);
    if (dir === gesture.dir) return;
    gesture.dir = dir;
    if (gesture.def.type === 'kana' || gesture.def.type === 'char') highlightGuide(dir);
  };

  /**
   * Finish the current press and fire its key (or the tapped candidate).
   * @param {number} x - Client X
   * @param {number} y - Client Y
   * @returns {void}
   * @example
   * endGesture(40, 20)
   */
  const endGesture = (x, y) => {
    if (!gesture) return;
    const { kind, def, x0, y0, fired, barTarget } = gesture;
    const threshold = handlers.getSettings().flickThreshold;
    cancelGesture();
    if (kind === 'bar') {
      if (!barTarget || Math.hypot(x - x0, y - y0) >= BAR_TAP_SLOP) return;
      if (barTarget.classList.contains('fjk-stock')) handlers.onAction('stock');
      else if (barTarget.classList.contains('fjk-update')) handlers.onUpdateTap();
      else if (barTarget.classList.contains('fjk-sugg')) handlers.onSuggestion(Number(barTarget.dataset.index));
      else handlers.onCandidate(Number(barTarget.dataset.index));
      return;
    }
    if (fired) return;
    const dir = getFlickDirection(x - x0, y - y0, threshold);
    if (def.type === 'kana') {
      handlers.onKana(def.id, dir);
    } else if (def.type === 'char') {
      // Only "up" means something on character keys; other directions count as a tap.
      handlers.onChar(def, dir === 'up' && def.up ? 'up' : 'center');
    } else if (getFlickDirection(x - x0, y - y0, threshold * 2) === 'center') {
      // Action keys fire on release unless the laser clearly slid away (twice the flick threshold).
      handlers.onAction(def.id);
    }
  };

  /**
   * Find our touch in a TouchList.
   * @param {TouchList} list - changedTouches
   * @returns {Touch|undefined} The touch of the current gesture
   * @example
   * findTouch(event.changedTouches)
   */
  const findTouch = (list) => Array.from(list).find((t) => gesture && t.identifier === gesture.id);

  /**
   * Start a press from a touch (VR laser trigger pulled).
   * @param {TouchEvent} e - The touchstart event
   * @returns {void}
   * @example
   * root.addEventListener('touchstart', onTouchStart)
   */
  const onTouchStart = (e) => {
    e.preventDefault(); // No emulated mouse events, no scrolling.
    e.stopPropagation();
    lastTouchTime = Date.now();
    if (gesture) return; // One press at a time; a second laser is ignored.
    const touch = e.changedTouches[0];
    if (touch) startGesture(e.target, touch.clientX, touch.clientY, 'touch', touch.identifier);
  };
  /**
   * Track a touch press.
   * @param {TouchEvent} e - The touchmove event
   * @returns {void}
   * @example
   * root.addEventListener('touchmove', onTouchMove)
   */
  const onTouchMove = (e) => {
    e.preventDefault();
    if (gesture?.source !== 'touch') return;
    const touch = findTouch(e.changedTouches);
    if (touch) moveGesture(touch.clientX, touch.clientY);
  };
  /**
   * Finish a touch press.
   * @param {TouchEvent} e - The touchend event
   * @returns {void}
   * @example
   * root.addEventListener('touchend', onTouchEnd)
   */
  const onTouchEnd = (e) => {
    e.preventDefault();
    e.stopPropagation();
    lastTouchTime = Date.now();
    if (gesture?.source !== 'touch') return;
    const touch = findTouch(e.changedTouches);
    if (touch) endGesture(touch.clientX, touch.clientY);
  };
  /**
   * Abort a touch press.
   * @param {TouchEvent} e - The touchcancel event
   * @returns {void}
   * @example
   * root.addEventListener('touchcancel', onTouchCancel)
   */
  const onTouchCancel = (e) => {
    if (gesture?.source === 'touch' && findTouch(e.changedTouches)) cancelGesture();
  };
  /**
   * Start a press from a mouse (desktop debugging fallback).
   * @param {PointerEvent} e - The pointerdown event
   * @returns {void}
   * @example
   * root.addEventListener('pointerdown', onPointerDown)
   */
  const onPointerDown = (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || gesture) return;
    if (Date.now() - lastTouchTime < MOUSE_AFTER_TOUCH_MS) return;
    if (startGesture(e.target, e.clientX, e.clientY, 'mouse', e.pointerId)) {
      e.preventDefault();
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        // Capture is optional.
      }
    }
  };
  /**
   * Track a mouse press.
   * @param {PointerEvent} e - The pointermove event
   * @returns {void}
   * @example
   * root.addEventListener('pointermove', onPointerMove)
   */
  const onPointerMove = (e) => {
    if (gesture?.source === 'mouse' && e.pointerId === gesture.id) moveGesture(e.clientX, e.clientY);
  };
  /**
   * Finish a mouse press.
   * @param {PointerEvent} e - The pointerup event
   * @returns {void}
   * @example
   * root.addEventListener('pointerup', onPointerUp)
   */
  const onPointerUp = (e) => {
    if (gesture?.source === 'mouse' && e.pointerId === gesture.id) endGesture(e.clientX, e.clientY);
  };
  /**
   * Abort a mouse press.
   * @param {PointerEvent} e - The pointercancel event
   * @returns {void}
   * @example
   * root.addEventListener('pointercancel', onPointerCancel)
   */
  const onPointerCancel = (e) => {
    if (gesture?.source === 'mouse' && e.pointerId === gesture.id) cancelGesture();
  };

  /**
   * Cancel an event's default action.
   * @param {Event} e - Event
   * @returns {void}
   * @example
   * el.addEventListener('contextmenu', preventDefault)
   */
  const preventDefault = (e) => e.preventDefault();

  const active = { passive: false };
  root.addEventListener('touchstart', onTouchStart, active);
  root.addEventListener('touchmove', onTouchMove, active);
  root.addEventListener('touchend', onTouchEnd, active);
  root.addEventListener('touchcancel', onTouchCancel);
  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerCancel);
  root.addEventListener('contextmenu', preventDefault);

  /**
   * Handle a press on the re-enable button (touch or mouse).
   * @param {Event} e - touchend or pointerup event
   * @returns {void}
   * @example
   * onReenable(event)
   */
  const onReenable = (e) => {
    if (e.type === 'pointerup' && (/** @type {PointerEvent} */ (e).pointerType !== 'mouse' || Date.now() - lastTouchTime < MOUSE_AFTER_TOUCH_MS)) return;
    if (e.type === 'touchend') lastTouchTime = Date.now();
    e.preventDefault();
    e.stopPropagation();
    handlers.onEnable();
  };
  reenable.addEventListener('touchstart', preventDefault, active);
  reenable.addEventListener('touchend', onReenable, active);
  reenable.addEventListener('pointerup', onReenable);

  /**
   * Bind a tap (touch or mouse) to a callback, the same way the re-enable button does.
   * @param {HTMLElement} node - Element to bind
   * @param {() => void} callback - Called once per tap
   * @returns {void}
   * @example
   * bindTap(yesButton, () => handlers.onUpdateAction('yes'))
   */
  const bindTap = (node, callback) => {
    const onTap = (e) => {
      if (e.type === 'pointerup' && (/** @type {PointerEvent} */ (e).pointerType !== 'mouse' || Date.now() - lastTouchTime < MOUSE_AFTER_TOUCH_MS)) return;
      if (e.type === 'touchend') lastTouchTime = Date.now();
      e.preventDefault();
      e.stopPropagation();
      callback();
    };
    node.addEventListener('touchstart', preventDefault, active);
    node.addEventListener('touchend', onTap, active);
    node.addEventListener('pointerup', onTap);
  };

  /** Last rendered banner content, to avoid rebuilding its buttons every microtask when nothing changed. */
  let renderedBanner = '';

  /**
   * Draw the update indicator dot(s) and the banner above them (see update.js for the state machine).
   * @param {import('./update.js').UpdateView|undefined} view - Update state (absent = nothing to show)
   * @returns {void}
   * @example
   * renderUpdate({ badge: true, banner: null })
   */
  const renderUpdate = (view) => {
    const badge = !!view?.badge;
    updateEl.classList.toggle('fjk-update-badge', badge);
    suggUpdateEl.classList.toggle('fjk-update-badge', badge);
    const banner = view?.banner ?? null;
    updateBanner.hidden = !banner;
    const key = banner ? JSON.stringify(banner) : '';
    if (key === renderedBanner) return;
    renderedBanner = key;
    updateBanner.replaceChildren();
    if (!banner) return;
    updateBanner.append(el(doc, 'div', 'fjk-update-title', banner.title ?? ''));
    if (banner.detail) updateBanner.append(el(doc, 'div', 'fjk-update-detail', banner.detail));
    if (banner.kind === 'confirm' || banner.kind === 'dismissable') {
      const actions = el(doc, 'div', 'fjk-update-actions');
      if (banner.kind === 'confirm') {
        const yes = el(doc, 'div', 'fjk-update-btn fjk-update-yes', banner.yes);
        const no = el(doc, 'div', 'fjk-update-btn', banner.no);
        bindTap(yes, () => handlers.onUpdateAction('yes'));
        bindTap(no, () => handlers.onUpdateAction('no'));
        actions.append(yes, no);
      } else {
        const close = el(doc, 'div', 'fjk-update-btn', banner.close);
        bindTap(close, () => handlers.onUpdateAction('dismiss'));
        actions.append(close);
      }
      updateBanner.append(actions);
    }
  };

  /** Last rendered suggestion strip. */
  let renderedSuggestions = '';

  /**
   * Draw the English suggestion strip (typed word, completions, corrections).
   * @param {import('./english.js').Suggestion[]} suggestions - Suggestions
   * @returns {void}
   * @example
   * renderSuggestions([{ text: 'hello', kind: 'completion' }])
   */
  const renderSuggestions = (suggestions) => {
    const key = suggestions.map((x) => `${x.kind}:${x.text}`).join('\u0000');
    if (key === renderedSuggestions) return;
    renderedSuggestions = key;
    suggListEl.replaceChildren(...suggestions.slice(0, MAX_SUGGESTIONS).map((x, index) => {
      const item = el(doc, 'div', `fjk-sugg fjk-sugg-${x.kind}`, x.text);
      item.dataset.index = String(index);
      return item;
    }));
    suggStockEl.hidden = suggestions.length > 0;
  };

  /** Last rendered candidate list, to avoid rebuilding it on every update. */
  let renderedCands = '';
  let renderedSelected = -2;

  /**
   * Draw the preedit: underlined, with the caret while composing or the current segment highlighted
   * while converting.
   * @param {ImeView} view - Composition view
   * @returns {void}
   * @example
   * renderPreedit(view)
   */
  const renderPreedit = (view) => {
    preeditEl.replaceChildren();
    if (!view.preedit) {
      preeditEl.hidden = true;
      return;
    }
    preeditEl.hidden = false;
    const chars = Array.from(view.preedit);
    if (view.phase === 'converting' && view.segLength > 0) {
      const a = view.segStart;
      const b = a + view.segLength;
      preeditEl.append(
        el(doc, 'span', 'fjk-pre', chars.slice(0, a).join('')),
        el(doc, 'span', 'fjk-pre fjk-seg', chars.slice(a, b).join('')),
        el(doc, 'span', 'fjk-pre', chars.slice(b).join('')),
      );
    } else if (view.phase === 'composing') {
      preeditEl.append(
        el(doc, 'span', 'fjk-pre', chars.slice(0, view.caret).join('')),
        el(doc, 'span', 'fjk-caret'),
        el(doc, 'span', 'fjk-pre', chars.slice(view.caret).join('')),
      );
    } else {
      preeditEl.append(el(doc, 'span', 'fjk-pre', view.preedit));
    }
    preeditEl.scrollLeft = preeditEl.scrollWidth;
  };

  /**
   * Draw the candidate grid and keep the selected candidate scrolled into view.
   * @param {ImeView} view - Composition view
   * @returns {void}
   * @example
   * renderCandidates(view)
   */
  const renderCandidates = (view) => {
    const key = view.candidates.join('\u0000');
    if (key !== renderedCands) {
      renderedCands = key;
      renderedSelected = -2;
      candsEl.replaceChildren(...view.candidates.map((text, index) => {
        const cand = el(doc, 'div', 'fjk-cand', text);
        cand.dataset.index = String(index);
        return cand;
      }));
      candsEl.scrollTop = 0;
    }
    if (view.selected === renderedSelected) return;
    renderedSelected = view.selected;
    for (const cand of candsEl.children) cand.classList.toggle('fjk-selected', Number(cand.dataset.index) === view.selected);
    const selected = candsEl.children[view.selected];
    if (selected) {
      const top = selected.offsetTop;
      const bottom = top + selected.offsetHeight;
      if (top < candsEl.scrollTop) candsEl.scrollTop = Math.max(0, top - 4);
      else if (bottom > candsEl.scrollTop + candsEl.clientHeight) candsEl.scrollTop = bottom - candsEl.clientHeight + 4;
    }
  };

  /**
   * Update a key's label text (only when it changed).
   * @param {{main: HTMLElement}} key - Rendered key
   * @param {string} text - New label
   * @returns {void}
   * @example
   * setLabel(key, '変換')
   */
  const setLabel = (key, text) => {
    if (key.main.textContent !== text) key.main.textContent = text;
  };

  /**
   * Show a page and update every state-dependent label, and the candidate bar.
   * @param {RenderState} state - What to show
   * @returns {void}
   * @example
   * render({ page: 'kana', mode: 'kana', shift: 'off', view })
   */
  const render = (state) => {
    if (current?.page !== state.page) {
      for (const [id, page] of builtPages) page.el.hidden = id !== state.page;
      buildPage(state.page).el.hidden = false;
      cancelGesture();
    }
    current = state;
    const { view, mode, shift } = state;
    const split = state.page === 'kana';
    root.classList.toggle('fjk-split', split);
    leftEl.hidden = !split;
    suggestEl.hidden = !['qwerty', 'num', 'num2'].includes(state.page);
    renderSuggestions(state.suggestions ?? []);
    renderUpdate(state.update);
    const composing = view.phase === 'composing' || view.phase === 'converting';
    root.classList.toggle('fjk-composing', composing);
    for (const key of buildPage(state.page).keys) {
      const { def, el: keyEl } = key;
      switch (def.id) {
        case 'space':
          if (state.page === 'kana') setLabel(key, view.phase === 'converting' ? '次候補' : composing ? '変換' : '空白');
          break;
        case 'enter':
          setLabel(key, composing ? '確定' : '⏎');
          keyEl.classList.toggle('fjk-accent', composing);
          break;
        case 'mode':
          keyEl.dataset.mode = mode;
          break;
        case 'back':
          setLabel(key, mode === 'kana' ? 'あいう' : 'ABC');
          break;
        case 'sym1':
        case 'sym2':
          keyEl.classList.toggle('fjk-on', def.id === state.page);
          break;
        case 'shift':
          setLabel(key, shift === 'lock' ? '⇪' : '⇧');
          keyEl.classList.toggle('fjk-on', shift !== 'off');
          keyEl.classList.toggle('fjk-lock', shift === 'lock');
          break;
        default:
          if (def.letter) setLabel(key, shift === 'off' ? def.ch : def.ch.toUpperCase());
      }
    }
    renderPreedit(view);
    renderCandidates(view);
    const idle = !composing;
    stockEl.hidden = !idle;
    placeholderEl.hidden = view.candidates.length > 0;
    placeholderEl.textContent = view.phase === 'direct'
      ? '変換なし（ひらがなを直接入力）'
      : idle ? '入力すると、ここに変換候補が出ます' : '';
  };

  let enabled = true;
  let bounds = { top: 0, bottom: 0 };

  /**
   * Apply host geometry: full overlay when enabled, only the small button when disabled.
   * @returns {void}
   * @example
   * applyHostStyle()
   */
  const applyHostStyle = () => {
    const base = 'position:fixed;z-index:2147483647;display:block;margin:0;padding:0;border:0;touch-action:none;';
    host.style.cssText = enabled
      ? `${base}left:0;right:0;top:${bounds.top}px;bottom:${bounds.bottom}px;`
      : `${base}right:0;top:0;width:48px;height:30px;`;
    root.hidden = !enabled;
    reenable.hidden = enabled;
  };

  applyHostStyle();
  (doc.body ?? doc.documentElement).append(host);

  /**
   * Show our keyboard (true) or only the small re-enable button (false).
   * @param {boolean} value - Enabled state
   * @returns {void}
   * @example
   * setEnabled(false)
   */
  const setEnabled = (value) => {
    enabled = !!value;
    cancelGesture();
    applyHostStyle();
  };

  /**
   * Fit the overlay to the stock key panel: below the buffered-mode text line and above the empty
   * strip at the bottom of the popup, where SteamVR draws the keyboard's move bar.
   * @param {{top: number, bottom: number}} value - Distances from the popup's top and bottom edges in CSS px
   * @returns {void}
   * @example
   * setBounds({ top: 40, bottom: 41 })
   */
  const setBounds = (value) => {
    if (value.top === bounds.top && value.bottom === bounds.bottom) return;
    bounds = { top: value.top, bottom: value.bottom };
    applyHostStyle();
  };

  /**
   * Remove the overlay from the popup.
   * @returns {void}
   * @example
   * destroy()
   */
  const destroy = () => {
    cancelGesture();
    host.remove();
  };

  /**
   * Rects of the overlay's parts in popup CSS px, plus how many candidates are visible (debug).
   * @returns {object} Measurements
   * @example
   * measure().pad // {x: 346, y: 3, w: 504, h: 233}
   */
  const measure = () => {
    /**
     * Rect of an element, rounded to 0.01 px.
     * @param {Element} node - Element
     * @returns {{x: number, y: number, w: number, h: number}} Rect
     * @example
     * rect(root)
     */
    const rect = (node) => {
      const b = node.getBoundingClientRect();
      const r2 = (v) => Math.round(v * 100) / 100;
      return { x: r2(b.left), y: r2(b.top), w: r2(b.width), h: r2(b.height) };
    };
    const page = current ? builtPages.get(current.page) : null;
    const rows = page ? [...page.el.children] : [];
    const cands = [...candsEl.children];
    const visible = cands.filter((c) => c.offsetTop >= candsEl.scrollTop && c.offsetTop + c.offsetHeight <= candsEl.scrollTop + candsEl.clientHeight);
    return {
      page: current?.page ?? null,
      root: rect(root),
      left: leftEl.hidden ? null : rect(leftEl),
      preedit: leftEl.hidden ? null : rect(topline),
      candidateGrid: leftEl.hidden ? null : rect(candsEl),
      pad: rect(pagesEl),
      suggestionStrip: suggestEl.hidden ? null : rect(suggestEl),
      suggestions: [...suggListEl.children].map((x) => x.textContent),
      rows: rows.map((row) => rect(row).h),
      firstRowKeys: rows[0] ? [...rows[0].children].map((k) => rect(k).w) : [],
      candidates: cands.length,
      visibleCandidates: visible.length,
      visibleCandidateRows: new Set(visible.map((c) => c.offsetTop)).size,
    };
  };

  return { host, setEnabled, setBounds, render, cancelGesture, measure, destroy };
};
