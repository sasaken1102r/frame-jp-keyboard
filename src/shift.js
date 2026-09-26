// Shift key state for the QWERTY keyboard. Pure logic.
// Tap once = the next letter is capital, double tap = caps lock, tap again = off.

/** Max gap in ms between two taps that count as a double tap. */
export const DOUBLE_TAP_MS = 400;

/**
 * @typedef {'off'|'once'|'lock'} ShiftState
 */

/**
 * Create a shift state machine.
 * @param {number} [doubleTapMs=DOUBLE_TAP_MS] - Double-tap window in ms
 * @returns {{
 *   readonly state: ShiftState,
 *   tap: (now?: number) => ShiftState,
 *   apply: (ch: string) => string,
 *   reset: () => void,
 * }} The shift state
 * @example
 * const shift = createShift();
 * shift.tap(0); // "once"
 * shift.apply('a'); // "A", and shift is off again
 */
export const createShift = (doubleTapMs = DOUBLE_TAP_MS) => {
  /** @type {ShiftState} */
  let state = 'off';
  let lastTap = -Infinity;

  /**
   * Handle a tap on the shift key.
   * @param {number} [now=Date.now()] - Time of the tap in ms
   * @returns {ShiftState} The new state
   * @example
   * tap(1000)
   */
  const tap = (now = Date.now()) => {
    if (state === 'off') state = 'once';
    else if (state === 'once') state = now - lastTap <= doubleTapMs ? 'lock' : 'off';
    else state = 'off';
    lastTap = now;
    return state;
  };

  /**
   * Apply shift to a typed character, and release a one-shot shift.
   * @param {string} ch - The character of the key (lower case for letters)
   * @returns {string} The character to type
   * @example
   * apply('q') // "Q" while shift is on
   */
  const apply = (ch) => {
    if (state === 'off') return ch;
    if (state === 'once') state = 'off';
    return ch.toUpperCase();
  };

  /**
   * Turn shift off.
   * @returns {void}
   * @example
   * reset()
   */
  const reset = () => {
    state = 'off';
    lastTap = -Infinity;
  };

  return {
    get state() {
      return state;
    },
    tap,
    apply,
    reset,
  };
};
