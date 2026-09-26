// Turns keyboard actions into output operations relative to a cursor. Pure logic, no DOM and no
// Steam objects, so it can be unit tested. Two instances are used: one types straight into the
// target (direct mode, QWERTY, and the fallback when conversion is unavailable), and one edits the
// kana being composed before conversion (its ops are mirrored into anthy, see mirror.js).
//
// We cannot read the target text field, so the composer remembers the characters it typed
// itself since the last cursor jump ("tail"). The ゛゜小 key, toggle input and undo only work on
// that known tail; anything that moves the cursor or submits (arrows, Enter) forgets it.
import { getFlickChar, getToggleSequence } from './kana-table.js';
import { cycleModifier } from './modifiers.js';

/**
 * An output operation: either literal text or a special key name understood by
 * VirtualKeyboardManager.HandleVirtualKeyDown ("Backspace", "Enter", "ArrowLeft", "ArrowRight").
 * @typedef {{text: string}|{key: string}} OutputOp
 */

/**
 * @typedef {object} ComposerSettings
 * @property {boolean} toggleInput - Repeated taps on the same key cycle its characters
 * @property {number} toggleTimeoutMs - Max gap between taps for toggle input
 */

const MAX_TAIL = 64;
const MAX_HISTORY = 100;

/**
 * Split a string into characters (code points).
 * @param {string} s - Input string
 * @returns {string[]} Characters
 * @example
 * chars('あい') // ["あ","い"]
 */
const chars = (s) => Array.from(s);

/**
 * Build the operations that replace `removed` characters before the cursor with `inserted`.
 * @param {string[]} removed - Characters to delete (they must be the ones right before the cursor)
 * @param {string[]} inserted - Characters to type afterwards
 * @returns {OutputOp[]} Operations
 * @example
 * replaceOps(['か'], ['が']) // [{key:"Backspace"},{text:"が"}]
 */
const replaceOps = (removed, inserted) => [
  ...removed.map(() => ({ key: 'Backspace' })),
  ...(inserted.length ? [{ text: inserted.join('') }] : []),
];

/**
 * Create a composer.
 * @param {() => ComposerSettings} getSettings - Returns the current settings (read on every action)
 * @returns {{
 *   input: (keyId: string, direction: string, now?: number) => OutputOp[],
 *   modify: () => OutputOp[],
 *   typeText: (text: string) => OutputOp[],
 *   backspace: () => OutputOp[],
 *   enter: () => OutputOp[],
 *   arrow: (direction: 'left'|'right') => OutputOp[],
 *   undo: () => OutputOp[],
 *   reset: () => void,
 *   load: (text: string) => void,
 *   replace: (count: number, text: string) => OutputOp[],
 *   readonly tail: string,
 * }} The composer
 * @example
 * const c = createComposer(() => ({ toggleInput: false, toggleTimeoutMs: 800 }));
 * c.input('a', 'left') // [{text:"い"}]
 * c.modify() // [{key:"Backspace"},{text:"ぃ"}]
 */
export const createComposer = (getSettings) => {
  /** @type {string[]} characters we typed that are known to sit right before the cursor */
  let tail = [];
  /** @type {{removed: string[], inserted: string[]}[]} */
  let history = [];
  /** @type {{keyId: string, index: number, time: number}|null} */
  let toggle = null;

  /**
   * Record an edit and apply it to the tail.
   * @param {string[]} removed - Characters removed before the cursor
   * @param {string[]} inserted - Characters inserted
   * @returns {OutputOp[]} Operations for the edit
   * @example
   * applyEdit([], ['あ']) // [{text:"あ"}]
   */
  const applyEdit = (removed, inserted) => {
    tail = [...tail.slice(0, tail.length - removed.length), ...inserted].slice(-MAX_TAIL);
    history.push({ removed, inserted });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    return replaceOps(removed, inserted);
  };

  /**
   * Forget everything we know about the text before the cursor.
   * @returns {void}
   * @example
   * forget()
   */
  const forget = () => {
    tail = [];
    history = [];
    toggle = null;
  };

  /**
   * Handle a tap or flick on a kana key.
   * @param {string} keyId - Kana key id
   * @param {string} direction - Flick direction
   * @param {number} [now=Date.now()] - Current time in ms (for toggle input)
   * @returns {OutputOp[]} Operations
   * @example
   * input('ka', 'center') // [{text:"か"}]
   */
  const input = (keyId, direction, now = Date.now()) => {
    const settings = getSettings();
    const seq = getToggleSequence(keyId);
    if (
      settings.toggleInput &&
      direction === 'center' &&
      toggle &&
      toggle.keyId === keyId &&
      now - toggle.time <= settings.toggleTimeoutMs &&
      seq.length > 1 &&
      tail.at(-1) === seq[toggle.index]
    ) {
      const previous = seq[toggle.index];
      const index = (toggle.index + 1) % seq.length;
      toggle = { keyId, index, time: now };
      return applyEdit([previous], [seq[index]]);
    }
    const ch = getFlickChar(keyId, direction);
    if (!ch) {
      toggle = null;
      return [];
    }
    toggle = direction === 'center' && seq.length > 1 ? { keyId, index: 0, time: now } : null;
    return applyEdit([], [ch]);
  };

  /**
   * Handle the ゛゜小 key: cycle the previous character we typed.
   * @returns {OutputOp[]} Operations (empty when there is nothing to modify)
   * @example
   * modify() // [{key:"Backspace"},{text:"が"}] after typing か
   */
  const modify = () => {
    toggle = null;
    const last = tail.at(-1);
    const next = cycleModifier(last);
    if (!next) return [];
    return applyEdit([last], [next]);
  };

  /**
   * Type literal text (space, symbols).
   * @param {string} text - Text to type
   * @returns {OutputOp[]} Operations
   * @example
   * typeText(' ') // [{text:" "}]
   */
  const typeText = (text) => {
    toggle = null;
    if (!text) return [];
    return applyEdit([], chars(text));
  };

  /**
   * Handle Backspace. Undo can restore the deleted character only when we typed it ourselves.
   * @returns {OutputOp[]} Operations
   * @example
   * backspace() // [{key:"Backspace"}]
   */
  const backspace = () => {
    toggle = null;
    if (tail.length === 0) {
      // Deleting text we never saw: earlier history no longer matches the field.
      history = [];
      return [{ key: 'Backspace' }];
    }
    return applyEdit([tail.at(-1)], []);
  };

  /**
   * Handle Enter (newline or submit). Forgets the known text.
   * @returns {OutputOp[]} Operations
   * @example
   * enter() // [{key:"Enter"}]
   */
  const enter = () => {
    forget();
    return [{ key: 'Enter' }];
  };

  /**
   * Handle the cursor keys. Forgets the known text because the cursor moves.
   * @param {'left'|'right'} direction - Cursor direction
   * @returns {OutputOp[]} Operations
   * @example
   * arrow('left') // [{key:"ArrowLeft"}]
   */
  const arrow = (direction) => {
    forget();
    return [{ key: direction === 'left' ? 'ArrowLeft' : 'ArrowRight' }];
  };

  /**
   * Undo the last edit we made (typing, ゛゜小, toggle, known Backspace).
   * @returns {OutputOp[]} Operations (empty when there is nothing to undo)
   * @example
   * undo() // [{key:"Backspace"}] right after typing one character
   */
  const undo = () => {
    toggle = null;
    const edit = history.pop();
    if (!edit) return [];
    tail = [...tail.slice(0, tail.length - edit.inserted.length), ...edit.removed].slice(-MAX_TAIL);
    return replaceOps(edit.inserted, edit.removed);
  };

  /**
   * Replace the known text before the cursor (e.g. the reading anthy returns when a conversion is
   * cancelled). History is cleared because it no longer matches.
   * @param {string} text - Text known to sit right before the cursor
   * @returns {void}
   * @example
   * load('かんじ')
   */
  const load = (text) => {
    forget();
    tail = chars(text).slice(-MAX_TAIL);
  };

  /**
   * Replace the last `count` characters before the cursor with `text` (English suggestion tap).
   * Undo restores the replaced characters when we typed them ourselves.
   * @param {number} count - Characters to delete (they must be ones we typed)
   * @param {string} text - Replacement
   * @returns {OutputOp[]} Operations
   * @example
   * replace(4, 'hello ') // [BS, BS, BS, BS, {text: "hello "}]
   */
  const replace = (count, text) => {
    toggle = null;
    if (count <= 0) return typeText(text);
    if (tail.length < count) {
      forget();
      return replaceOps(Array.from({ length: count }, () => ''), chars(text));
    }
    return applyEdit(tail.slice(-count), chars(text));
  };

  return {
    input,
    modify,
    typeText,
    backspace,
    enter,
    arrow,
    undo,
    reset: forget,
    load,
    replace,
    get tail() {
      return tail.join('');
    },
  };
};
