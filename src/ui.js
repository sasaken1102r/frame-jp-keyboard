// DOM layer: our keyboard, drawn inside the stock VR keyboard popup's document.
//
// Input notes (measured on the device, 2026-09-26): the VR laser arrives as touch events
// (touchstart -> touchmove ~90 Hz -> touchend, coordinates in changedTouches[0]). With the default
// touch-action the browser pans and fires pointercancel, so everything here is touch-action:none
// and we listen to touch events. Mouse pointer events are a fallback for desktop debugging.
// With both controllers on the keyboard there is only one DOM touch, and a press with the laser
// SteamVR does not focus has no movement at all; so touchstart/touchend mark press and release, and
// the pressing laser (its press marker) gives the movement and, at release, the end point
// (cursor-tracker.js), when the popup offers SteamClient.OpenVR.VROverlay.RegisterForCursorMovement.
// Because default panning is off, the candidate panel is scrolled by our own drag handling.
//
// Layout: on the kana page the panel is split horizontally, with the composition panel on the left
// (preedit line, a wrapping candidate grid that scrolls vertically, then a bar with the close
// button, the update indicator and "Steam ⌨") and the 12-key flick pad on
// the right, using the full height. QWERTY, numbers and symbols use the full width; the QWERTY and
// number pages get a one-row English suggestion strip above the keys.
import { createCursorTracker } from './cursor-tracker.js';
import { createInputRecorder } from './input-recorder.js';
import { getFlickDirection, DIRECTIONS } from './flick.js';
import { createIcon, hasIcon } from './icons.js';
import { getFlickCandidates } from './kana-table.js';
import { isIndicatorShown } from './update.js';
import { PAGES } from './layout.js';
import { OVERLAY_CSS } from './styles.js';

const HOST_ID = 'fjk-host';
const REPEAT_DELAY_MS = 450;
const REPEAT_INTERVAL_MS = 70;
const LONG_PRESS_MS = 550;
/** English suggestions shown in the strip (5 fit next to the close and Steam buttons at 854 px). */
const MAX_SUGGESTIONS = 5;
/** Movement (CSS px) below which a press on the candidate bar is a tap rather than a scroll. */
const BAR_TAP_SLOP = 12;
/** After touchend, wait this long for the pressing laser's release event (it can come just after). */
const RELEASE_WAIT_MS = 25;
/**
 * The laser SteamVR does not focus reports nothing while pressed (only its release point), so its
 * flick cannot be previewed live; the guide then shows the chosen direction this long after release.
 */
const RELEASE_FLASH_MS = 220;
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
 * @property {(actionId: string) => void} onAction - An action key fired (also "close", "stock", "cut", "copy" and "paste" from the panel buttons)
 * @property {(index: number) => void} onCandidate - A candidate was tapped
 * @property {(index: number) => void} onSuggestion - An English suggestion was tapped
 * @property {() => void} onEnable - The re-enable button was pressed
 * @property {(record: object) => void} [onGesture] - A key gesture ended (numbers only; debug log)
 * @property {(window: {press: number, entries: any[]}) => void} [onRecord] - Raw input around a press (temporary recorder)
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
 * @property {{text: string, caret: number}} [english] - English word being composed (QWERTY pages)
 * @property {import('./update.js').UpdateView} [update] - Update indicator state (see update.js)
 * @property {{ctrl: boolean, alt: boolean}} [modifiers] - Armed one-shot Ctrl / Alt (QWERTY and number pages)
 */

/**
 * @typedef {object} Overlay
 * @property {HTMLElement} host - Shadow host element in the popup document
 * @property {(enabled: boolean) => void} setEnabled - Show our keyboard, or only the re-enable button
 * @property {(bounds: {top: number, bottom: number}) => void} setBounds - Move the overlay's top and bottom edges (CSS px from each edge)
 * @property {(state: RenderState) => void} render - Show a page, labels and the candidate bar
 * @property {() => void} cancelGesture - Abort any press in progress
 * @property {() => object} measure - Rects of the overlay's parts (debug)
 * @property {() => string} preeditText - The preedit as drawn right now (debug)
 * @property {() => object} gestures - Recent key gestures and laser cursors (debug; numbers only)
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
  /**
   * Create a close-keyboard button (fires on release, like the other panel buttons).
   * @returns {HTMLElement} The button
   * @example
   * makeCloseButton()
   */
  const makeCloseButton = () => {
    const button = el(doc, 'div', 'fjk-close');
    button.title = 'キーボードを閉じる';
    button.append(createIcon(doc, 'close'));
    return button;
  };
  /**
   * Create the update indicator: a dot inside a tap target (see renderUpdate and styles.js).
   * @returns {HTMLElement} The indicator
   * @example
   * makeUpdateIndicator()
   */
  const makeUpdateIndicator = () => {
    const indicator = el(doc, 'div', 'fjk-update');
    indicator.title = '更新を確かめる';
    indicator.append(el(doc, 'span', 'fjk-update-dot'));
    return indicator;
  };
  // Kana page: the reading line shows only the reading; the panel buttons live in a bar below
  // the candidates (close on the left; the update indicator and "Steam ⌨" on the right).
  /**
   * Create the cut / copy / paste icon buttons (they fire the "cut", "copy" and "paste" actions).
   * @returns {HTMLElement} The group
   * @example
   * makeClipButtons()
   */
  const makeClipButtons = () => {
    const group = el(doc, 'div', 'fjk-clips');
    for (const [action, label] of [['cut', '切り取り'], ['copy', 'コピー'], ['paste', '貼り付け']]) {
      const button = el(doc, 'div', 'fjk-clip');
      button.title = label;
      button.setAttribute('aria-label', label);
      button.append(createIcon(doc, action));
      button.dataset.action = action;
      group.append(button);
    }
    return group;
  };
  topline.append(preeditEl);
  const closeEl = makeCloseButton();
  const updateEl = makeUpdateIndicator();
  const kanaClipsEl = makeClipButtons();
  const kanaBar = el(doc, 'div', 'fjk-kbar fjk-btnrow');
  kanaBar.append(closeEl, kanaClipsEl, el(doc, 'div', 'fjk-kbar-space'), updateEl, stockEl);
  const candsEl = el(doc, 'div', 'fjk-cands');
  const placeholderEl = el(doc, 'div', 'fjk-placeholder');
  leftEl.append(topline, candsEl, placeholderEl, kanaBar);
  const rightEl = el(doc, 'div', 'fjk-right');
  // Full-width pages: close on the left, the English word and suggestions in the middle, the
  // update indicator and "Steam ⌨" on the right (the same buttons as the kana bar).
  const suggestEl = el(doc, 'div', 'fjk-suggest fjk-candbar fjk-btnrow');
  const suggListEl = el(doc, 'div', 'fjk-sugg-list');
  // The English word being typed (underlined); tapping it commits it as typed.
  const compEl = el(doc, 'div', 'fjk-sugg fjk-sugg-comp');
  compEl.dataset.index = '-1';
  const suggStockEl = el(doc, 'div', 'fjk-stock', 'Steam ⌨');
  suggStockEl.title = 'Steam の純正キーボードに切り替え';
  const suggCloseEl = makeCloseButton();
  const suggUpdateEl = makeUpdateIndicator();
  // Cut / copy / paste, shown while no English word is being typed (the word and its suggestions
  // take the strip then).
  const clipsEl = makeClipButtons();
  suggestEl.append(suggCloseEl, clipsEl, compEl, suggListEl, suggUpdateEl, suggStockEl);
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
   * @property {number|null} [presser] - Index of the pressing laser, when known
   * @property {{x: number, y: number}|null} [cursorBase] - The pressing laser's first report after the press
   * @property {{x: number, y: number}|null} [cursorPoint] - Current point from the pressing laser's stream
   * @property {string} [endSource] - Where the end point came from: release, stream or touch
   * @property {boolean} [released] - touchend seen; waiting for the laser's release event
   * @property {object[]} [startCursors] - All cursors at the press (gesture log)
   */
  /** @type {Gesture|null} */
  let gesture = null;
  let lastTouchTime = 0;
  /** @type {(() => void)|null} A released press waiting for its laser's release event. */
  let pendingFinish = null;

  const popupWindow = doc.defaultView;
  const dpr = popupWindow?.devicePixelRatio || 1;
  // Cursor positions are expected in the popup's CSS px (like touch clientX/Y); if they turn out to
  // be device pixels, the scale that fits the first press is learned (1, dpr or 1/dpr).
  const tracker = createCursorTracker({ scales: dpr === 1 ? [1] : [1, dpr, 1 / dpr] });
  /** Recent key gestures, numbers only (debug). */
  let gestureLog = [];

  /**
   * A laser cursor moved (SteamVR reports each controller's cursor separately).
   * @param {number} index - Cursor index
   * @param {boolean} active - Whether it is on the popup
   * @param {number} x - X
   * @param {number} y - Y
   * @returns {void}
   * @example
   * onCursor(1, true, 400, 120)
   */
  const onCursor = (index, active, x, y) => {
    tracker.update(index, !!active, Number(x), Number(y));
    const g = gesture;
    // After touchend the stream is laser movement after the release: it no longer moves the press.
    if (!active || !g || g.presser !== index || g.released) return;
    // The first report after the press is where the laser was at touchstart.
    g.cursorBase ??= { x: Number(x), y: Number(y) };
    g.cursorPoint = { x: g.x0 + (Number(x) - g.cursorBase.x), y: g.y0 + (Number(y) - g.cursorBase.y) };
    moveGesture(g.cursorPoint.x, g.cursorPoint.y);
  };
  // Temporary passive recorder of raw input around presses (numbers only; see input-recorder.js).
  const recorder = handlers.onRecord ? createInputRecorder({ onWindow: handlers.onRecord }) : null;
  const recordTypes = ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel'];
  /**
   * Feed a DOM event to the recorder.
   * @param {Event} e - Touch or pointer event
   * @returns {void}
   * @example
   * recordEvent(event)
   */
  const recordEvent = (e) => (e.type.startsWith('touch') ? recorder.touch(e) : recorder.pointer(e));
  if (recorder) for (const type of recordTypes) doc.addEventListener(type, recordEvent, { capture: true, passive: true });

  let cursorHandle = null;
  try {
    cursorHandle = popupWindow?.SteamClient?.OpenVR?.VROverlay?.RegisterForCursorMovement?.((...args) => {
      recorder?.cursor(...args);
      onCursor(...args);
    }) ?? null;
  } catch {
    cursorHandle = null; // Touch events alone then.
  }
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

  /** @type {ReturnType<typeof setTimeout>|undefined} Hides the guide after a release flash. */
  let flashTimer;

  /**
   * Show the guide (still laid out for the released key) with the chosen direction, briefly.
   * @param {string} dir - Direction that fired
   * @returns {void}
   * @example
   * flashGuide('up')
   */
  const flashGuide = (dir) => {
    clearTimeout(flashTimer);
    guide.hidden = false;
    highlightGuide(dir);
    flashTimer = setTimeout(() => {
      if (!gesture) guide.hidden = true;
    }, RELEASE_FLASH_MS);
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
    clearTimeout(flashTimer);
    guide.hidden = true;
    let presser = null;
    let startCursors;
    if (source === 'touch' && cursorHandle) {
      presser = tracker.pressingIndex() ?? tracker.pick(x, y)?.index ?? null;
      startCursors = tracker.snapshot();
    }
    const base = {
      source, id, x0: x, y0: y, dir: 'center', timer: undefined, fired: false,
      presser, cursorBase: null, cursorPoint: null, startCursors,
    };
    if (closest(target, '.fjk-candbar')) {
      cancelGesture();
      const barTarget = closest(target, '.fjk-cand') ?? closest(target, '.fjk-sugg') ?? closest(target, '.fjk-close')
        ?? closest(target, '.fjk-clip') ?? closest(target, '.fjk-update') ?? closest(target, '.fjk-stock');
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
    // A key with an up-flick (← / →) stops waiting to auto-repeat once the laser moves off it.
    if (gesture.def.upAction && dir !== 'center' && !gesture.fired) {
      clearTimeout(gesture.timer);
      gesture.timer = undefined;
    }
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
    const { kind, def, x0, y0, fired, barTarget, source, presser, endSource, startCursors } = gesture;
    const threshold = handlers.getSettings().flickThreshold;
    cancelGesture();
    if (kind === 'key') {
      const record = {
        source,
        presser: presser ?? null,
        end: endSource ?? source,
        start: [Math.round(x0), Math.round(y0)],
        endPoint: [Math.round(x), Math.round(y)],
        dir: getFlickDirection(x - x0, y - y0, threshold),
        cursors: startCursors ?? null,
        key: def.type, // "kana", "char" or "action": no text
      };
      gestureLog = [...gestureLog, record].slice(-30);
      handlers.onGesture?.(record);
    }
    if (kind === 'bar') {
      if (!barTarget || Math.hypot(x - x0, y - y0) >= BAR_TAP_SLOP) return;
      if (barTarget.classList.contains('fjk-close')) handlers.onAction('close');
      else if (barTarget.classList.contains('fjk-stock')) handlers.onAction('stock');
      else if (barTarget.classList.contains('fjk-update')) handlers.onUpdateTap();
      else if (barTarget.classList.contains('fjk-clip')) handlers.onAction(barTarget.dataset.action);
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
    } else if (def.upAction && getFlickDirection(x - x0, y - y0, threshold) === 'up') {
      handlers.onAction(def.upAction);
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
    pendingFinish?.();
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
    if (gesture?.source !== 'touch' || gesture.cursorPoint) return;
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
    if (!touch) return;
    const g = gesture;
    const tEnd = performance.now();
    const touchEnd = { x: touch.clientX, y: touch.clientY };
    g.released = true;
    /**
     * Finish the press: the pressing laser's release point, else its streamed point, else the touch.
     * @returns {void}
     * @example
     * finish()
     */
    const finish = () => {
      pendingFinish = null;
      if (gesture !== g) return;
      const release = g.presser === null ? null : tracker.releasePoint(g.presser, tEnd);
      g.endSource = release ? 'release' : g.cursorPoint ? 'stream' : 'touch';
      const p = release ?? g.cursorPoint ?? touchEnd;
      // No live movement from this laser: show what was picked once the release point is known.
      const blind = release && !g.cursorPoint && g.kind === 'key' && (g.def?.type === 'kana' || g.def?.type === 'char');
      endGesture(p.x, p.y);
      if (blind) flashGuide(getFlickDirection(p.x - g.x0, p.y - g.y0, handlers.getSettings().flickThreshold));
    };
    if (g.presser === null) {
      finish();
      return;
    }
    pendingFinish = finish;
    setTimeout(() => pendingFinish === finish && finish(), RELEASE_WAIT_MS);
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
   * Draw the English word being composed: underlined, with the caret.
   * @param {{text: string, caret: number}} english - Word and caret
   * @returns {void}
   * @example
   * renderEnglish({ text: 'helo', caret: 4 })
   */
  const renderEnglish = (english) => {
    const chars = Array.from(english.text);
    compEl.hidden = chars.length === 0;
    clipsEl.hidden = chars.length > 0;
    compEl.replaceChildren(
      el(doc, 'span', 'fjk-pre', chars.slice(0, english.caret).join('')),
      el(doc, 'span', 'fjk-caret'),
      el(doc, 'span', 'fjk-pre', chars.slice(english.caret).join('')),
    );
  };

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
    // Candidates of an older reading stay visible but dimmed until fresh ones arrive.
    candsEl.classList.toggle('fjk-stale', !!view.stale);
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
    // The strip (with the close and Steam buttons) is on every full-width page.
    suggestEl.hidden = !['qwerty', 'num', 'num2', 'sym1', 'sym2'].includes(state.page);
    renderSuggestions(state.suggestions ?? []);
    renderEnglish(state.english ?? { text: '', caret: 0 });
    renderUpdate(state.update);
    const composing = view.phase === 'composing' || view.phase === 'converting';
    // The update indicator steps aside while anything is being typed (its badge state is kept).
    const kanaComposing = composing || view.preedit.length > 0;
    const indicatorShown = isIndicatorShown({ kanaComposing, englishWord: state.english?.text ?? '' });
    // The kana bar's clipboard buttons step aside while a reading is typed, like the indicator.
    kanaClipsEl.hidden = kanaComposing;
    updateEl.hidden = !indicatorShown;
    suggUpdateEl.hidden = !indicatorShown;
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
        case 'ctrl':
        case 'alt':
          keyEl.classList.toggle('fjk-on', !!state.modifiers?.[def.id]);
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
    try {
      cursorHandle?.unregister?.();
      cursorHandle?.Unregister?.();
    } catch {
      // Already gone with the popup.
    }
    cursorHandle = null;
    if (recorder) for (const type of recordTypes) doc.removeEventListener(type, recordEvent, { capture: true });
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

  /**
   * The preedit text as currently drawn in the panel (debug: echo latency).
   * @returns {string} Text
   * @example
   * preeditText() // "かんじ"
   */
  const preeditText = () => preeditEl.textContent ?? '';

  /**
   * Recent key gestures and the cursor state (debug; numbers only).
   * @returns {{registered: boolean, scale: number|null, dpr: number, cursors: object[], gestures: object[]}} Info
   * @example
   * gestures().gestures.at(-1).cursor
   */
  const gestures = () => ({ registered: !!cursorHandle, scale: tracker.scale, dpr, cursors: tracker.snapshot(), gestures: [...gestureLog] });

  return { host, setEnabled, setBounds, render, cancelGesture, measure, preeditText, gestures, destroy };
};
