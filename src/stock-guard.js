// Keeps the stock keyboard under our overlay quiet while ours is shown.
//
// The stock keyboard stays mounted under our overlay and keeps Steam's gamepad focus in the popup.
// Steam delivers controller buttons as bubbling custom DOM events ("vgp_onbuttondown" and
// "vgp_onbuttonup", button number in detail.button) dispatched on the stock key that has gamepad
// focus; the stock keyboard then types that key (A), Backspace (X), Space (Y), Enter or a click at
// the laser (right trigger), Shift (left trigger), candidate paging (bumpers) and so on, through its
// own IBus context. A Japanese composition there adds a candidate row at the top of the stock panel;
// the panel grows downwards and its bottom row shows in the move-bar strip below our overlay. Text it
// commits, and Enter, would also reach the app behind our back.
//
// While our overlay is enabled we therefore
//  1. swallow those button events in the capture phase on the popup window, except B (the stock
//     "close keyboard"), Start, Select and the Steam buttons, and
//  2. make the stock key panel transparent and click-through, so that even if it grows it can never
//     peek out below our overlay or take a laser press there.
// Both are undone when our overlay is disabled (stock keyboard chosen) or removed.

/** Steam's gamepad button numbers that stay with Steam while our overlay is shown. */
export const PASS_THROUGH_BUTTONS = new Set([
  2, // B: close the keyboard
  13, // Select
  14, // Start
  27, // Steam button
  28, // Quick access button
]);

/** Raw button events; filtered by button number. */
const BUTTON_EVENTS = new Set(['vgp_onbuttondown', 'vgp_onbuttonup']);
/** Logical events Steam derives from a button press that would act on the focused stock key. */
const LOGICAL_EVENTS = new Set(['vgp_onok', 'vgp_onsecondaryaction', 'vgp_onoptions', 'vgp_ondirection']);
/** Every event type we listen to. */
export const GUARDED_EVENTS = Object.freeze([...BUTTON_EVENTS, ...LOGICAL_EVENTS]);

const STYLE_ID = 'fjk-stock-guard';
/**
 * The stock key panel (standard, numeric and emoji pages all use one grid panel; the standard page
 * also carries a "Layout_<name>" class). Opacity keeps its layout and rect, which our bounds use,
 * and keeps Steam's own visibility checks happy.
 */
const STOCK_GUARD_CSS = '[role="grid"], [class*="Layout_"] { opacity: 0 !important; pointer-events: none !important; }';

/**
 * Decide whether a gamepad event in the popup must be kept from the stock keyboard.
 * @param {string} type - Event type
 * @param {{button?: unknown}|null|undefined} detail - Event detail
 * @returns {boolean} True to swallow it
 * @example
 * shouldSwallow('vgp_onbuttondown', { button: 1 }) // true (A would press the focused stock key)
 * shouldSwallow('vgp_onbuttondown', { button: 2 }) // false (B still closes the keyboard)
 */
export const shouldSwallow = (type, detail) => {
  if (LOGICAL_EVENTS.has(type)) return true;
  if (!BUTTON_EVENTS.has(type)) return false;
  return !PASS_THROUGH_BUTTONS.has(detail?.button);
};

/**
 * @typedef {object} StockGuard
 * @property {(active: boolean) => void} setActive - Guard the stock keyboard (true) or give it back (false)
 * @property {() => {active: boolean, swallowed: number}} stats - Whether it is on and how many events it swallowed (debug)
 * @property {() => void} destroy - Undo everything
 */

/**
 * Create the guard for a keyboard popup document. It starts inactive.
 * @param {Document} doc - The popup's document
 * @returns {StockGuard} The guard
 * @example
 * const guard = createStockGuard(popupWindow.document);
 * guard.setActive(true);
 */
export const createStockGuard = (doc) => {
  const target = doc.defaultView ?? doc;
  let active = false;
  let swallowed = 0;
  /** @type {HTMLStyleElement|null} */
  let style = null;

  /**
   * Capture-phase listener: stop a guarded event before any stock handler sees it.
   * @param {Event & {detail?: {button?: number}}} e - Gamepad event
   * @returns {void}
   * @example
   * window.addEventListener('vgp_onbuttondown', onGamepadEvent, true)
   */
  const onGamepadEvent = (e) => {
    if (!shouldSwallow(e.type, e.detail)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    swallowed += 1;
  };

  /**
   * Add or remove the listeners and the stylesheet.
   * @param {boolean} value - True to guard the stock keyboard
   * @returns {void}
   * @example
   * setActive(false)
   */
  const setActive = (value) => {
    const next = !!value;
    if (next === active) return;
    active = next;
    try {
      for (const type of GUARDED_EVENTS) {
        if (active) target.addEventListener(type, onGamepadEvent, true);
        else target.removeEventListener(type, onGamepadEvent, true);
      }
      if (active) {
        doc.getElementById(STYLE_ID)?.remove();
        style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = STOCK_GUARD_CSS;
        (doc.head ?? doc.documentElement).append(style);
      } else {
        style?.remove();
        style = null;
      }
    } catch {
      // The popup is already gone; nothing left to guard or restore.
    }
  };

  /**
   * Current state (debug).
   * @returns {{active: boolean, swallowed: number}} State
   * @example
   * stats() // { active: true, swallowed: 4 }
   */
  const stats = () => ({ active, swallowed });

  /**
   * Give everything back to the stock keyboard.
   * @returns {void}
   * @example
   * destroy()
   */
  const destroy = () => setActive(false);

  return { setActive, stats, destroy };
};
