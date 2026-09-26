// Which page of our keyboard is shown. Pure logic.
//
//   kana   12-key flick (Japanese mode)          qwerty  letters (English mode)
//   sym1/sym2  Japanese symbol pages (☺記)        num / num2  numbers and ASCII symbols (123, #+=)
//
// The mode (kana or qwerty) is what あA toggles and what the settings remember. Symbol and number
// pages are temporary and go back to their mode's main page.

/** @typedef {'kana'|'qwerty'} Mode */
/** @typedef {'kana'|'qwerty'|'num'|'num2'|'sym1'|'sym2'} PageId */

export const MODES = Object.freeze(['kana', 'qwerty']);
export const SYMBOL_PAGES = Object.freeze(['sym1', 'sym2']);

/**
 * Normalize a stored mode.
 * @param {unknown} value - Stored value
 * @returns {Mode} A valid mode (kana by default)
 * @example
 * toMode('qwerty') // "qwerty"
 * toMode('bogus') // "kana"
 */
export const toMode = (value) => (value === 'qwerty' ? 'qwerty' : 'kana');

/**
 * Create the page state.
 * @param {unknown} initialMode - Mode to start in (from settings)
 * @returns {{
 *   readonly mode: Mode,
 *   readonly page: PageId,
 *   toggleMode: () => Mode,
 *   show: (page: PageId) => PageId,
 *   back: () => PageId,
 * }} The state
 * @example
 * const pages = createKeyboardState('kana');
 * pages.toggleMode(); // "qwerty"
 * pages.show('num'); // "num"
 * pages.back(); // "qwerty"
 */
export const createKeyboardState = (initialMode) => {
  /** @type {Mode} */
  let mode = toMode(initialMode);
  /** @type {PageId} */
  let page = mode;

  /**
   * Switch between kana and QWERTY; always lands on the new mode's main page.
   * @returns {Mode} The new mode
   * @example
   * toggleMode()
   */
  const toggleMode = () => {
    mode = mode === 'kana' ? 'qwerty' : 'kana';
    page = mode;
    return mode;
  };

  /**
   * Show a page (symbols or numbers). Showing a main page also switches the mode.
   * @param {PageId} next - Page to show
   * @returns {PageId} The page shown
   * @example
   * show('sym1')
   */
  const show = (next) => {
    if (next === 'kana' || next === 'qwerty') mode = next;
    page = next;
    return page;
  };

  /**
   * Go back to the current mode's main page.
   * @returns {PageId} The page shown
   * @example
   * back()
   */
  const back = () => {
    page = mode;
    return page;
  };

  return {
    get mode() {
      return mode;
    },
    get page() {
      return page;
    },
    toggleMode,
    show,
    back,
  };
};
