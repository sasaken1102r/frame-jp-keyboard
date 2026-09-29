// Esc, Ctrl and Alt on the QWERTY keyboard, and the copy / cut / paste buttons. Pure logic.
//
// Key chords (Ctrl+C, Alt+F4, ...) cannot be typed as text, so they go out as key presses: each key
// is pressed and released in order, modifiers first and released last (see planChord). The codes are
// the USB HID keyboard usage IDs for ordinary keys, which is what Steam's own key-state call takes,
// plus Steam's own codes for the modifier keys (100 and up; see MODIFIER_CODES).
//
// Ctrl and Alt are one-shot ("sticky") modifiers: tap to arm, the next key goes out with them held,
// then they disarm by themselves (see createModifiers). They are never held down between chords, so
// nothing can stay pressed when the keyboard closes or the page changes.

/** @typedef {'ctrl'|'alt'|'shift'} ModifierName */
/** @typedef {[code: number, down: boolean]} KeyEvent */

/** Steam's codes for the left modifier keys. */
export const MODIFIER_CODES = Object.freeze({ alt: 100, shift: 101, ctrl: 103 });

/** Order in which modifiers are pressed (and, reversed, released). */
const MODIFIER_ORDER = /** @type {const} */ (['ctrl', 'alt', 'shift']);

/** USB HID usage IDs of the named (non-character) keys we send. */
export const NAMED_KEY_CODES = Object.freeze({
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
});

/** Unshifted US-layout characters and their USB HID usage IDs (letters and digits are computed). */
const PLAIN_CHAR_CODES = Object.freeze({
  ' ': 44, '-': 45, '=': 46, '[': 47, ']': 48, '\\': 49, ';': 51, "'": 52, '`': 53, ',': 54, '.': 55, '/': 56,
});

/** Shifted US-layout characters: the unshifted character on the same key. */
const SHIFTED_CHARS = Object.freeze({
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '~': '`', '<': ',', '>': '.', '?': '/',
});

/**
 * The key (and whether Shift is part of it) that types a character on a US layout.
 * @param {string} ch - One character
 * @returns {{code: number, shift: boolean}|null} The key, or null when no single key types it
 * @example
 * keyForChar('a') // { code: 4, shift: false }
 * keyForChar('A') // { code: 4, shift: true }
 * keyForChar('!') // { code: 30, shift: true }
 * keyForChar('あ') // null
 */
export const keyForChar = (ch) => {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  if (ch >= 'a' && ch <= 'z') return { code: 4 + ch.charCodeAt(0) - 97, shift: false };
  if (ch >= 'A' && ch <= 'Z') return { code: 4 + ch.charCodeAt(0) - 65, shift: true };
  if (ch >= '1' && ch <= '9') return { code: 30 + ch.charCodeAt(0) - 49, shift: false };
  if (ch === '0') return { code: 39, shift: false };
  if (ch in PLAIN_CHAR_CODES) return { code: PLAIN_CHAR_CODES[ch], shift: false };
  if (ch in SHIFTED_CHARS) return { code: keyForChar(SHIFTED_CHARS[ch]).code, shift: true };
  return null;
};

/**
 * The key for a named key ("Escape", "Enter", "ArrowLeft", ...).
 * @param {string} name - Key name
 * @returns {{code: number, shift: boolean}|null} The key, or null for an unknown name
 * @example
 * keyForName('Escape') // { code: 41, shift: false }
 */
export const keyForName = (name) => (Object.hasOwn(NAMED_KEY_CODES, name) ? { code: NAMED_KEY_CODES[name], shift: false } : null);

/**
 * Plan the key presses of one chord: modifiers down (Ctrl, Alt, Shift), the key down and up, then
 * the modifiers up in reverse order.
 * @param {{ctrl?: boolean, alt?: boolean, shift?: boolean}} modifiers - Modifiers to hold
 * @param {{code: number, shift: boolean}} key - The key (its own shift is added to the modifiers)
 * @returns {KeyEvent[]} Events in order
 * @example
 * planChord({ ctrl: true }, keyForChar('c')) // [[103,true],[6,true],[6,false],[103,false]]
 */
export const planChord = (modifiers, key) => {
  const held = { ...modifiers, shift: !!modifiers.shift || key.shift };
  const codes = MODIFIER_ORDER.filter((name) => held[name]).map((name) => MODIFIER_CODES[name]);
  return [
    ...codes.map((code) => /** @type {KeyEvent} */ ([code, true])),
    [key.code, true],
    [key.code, false],
    ...[...codes].reverse().map((code) => /** @type {KeyEvent} */ ([code, false])),
  ];
};

/** The clipboard buttons and the Ctrl chords they send. */
export const CLIPBOARD_CHORDS = Object.freeze({ cut: 'x', copy: 'c', paste: 'v' });

/**
 * Create the one-shot Ctrl / Alt state of the QWERTY keyboard.
 * @returns {{
 *   readonly ctrl: boolean,
 *   readonly alt: boolean,
 *   readonly active: boolean,
 *   toggle: (name: 'ctrl'|'alt') => void,
 *   take: () => {ctrl: boolean, alt: boolean},
 *   clear: () => void,
 * }} The state
 * @example
 * const mods = createModifiers();
 * mods.toggle('ctrl');
 * mods.take(); // { ctrl: true, alt: false } (and both are off again)
 */
export const createModifiers = () => {
  let ctrl = false;
  let alt = false;

  /**
   * Tap Ctrl or Alt: arm it, or disarm it when it is already armed.
   * @param {'ctrl'|'alt'} name - Modifier
   * @returns {void}
   * @example
   * toggle('alt')
   */
  const toggle = (name) => {
    if (name === 'ctrl') ctrl = !ctrl;
    else if (name === 'alt') alt = !alt;
  };

  /**
   * Take the armed modifiers for the next key and disarm them.
   * @returns {{ctrl: boolean, alt: boolean}} The modifiers that were armed
   * @example
   * take()
   */
  const take = () => {
    const taken = { ctrl, alt };
    ctrl = false;
    alt = false;
    return taken;
  };

  /**
   * Disarm both (page change, keyboard closed, Esc while composing).
   * @returns {void}
   * @example
   * clear()
   */
  const clear = () => {
    ctrl = false;
    alt = false;
  };

  return {
    get ctrl() {
      return ctrl;
    },
    get alt() {
      return alt;
    },
    get active() {
      return ctrl || alt;
    },
    toggle,
    take,
    clear,
  };
};
