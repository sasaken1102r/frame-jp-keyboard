// Live conversion candidates while typing: merging what anthy reports into one ordered list, and
// the debounce / generation helpers that keep candidate queries from slowing down typing.
// Pure logic, no IBus objects and no DOM.

/**
 * @typedef {'whole'|'segment'|'prediction'|'hiragana'|'katakana'} CandidateKind
 * @typedef {{text: string, kind: CandidateKind, index: number}} LiveCandidate
 *   `index` is the position in anthy's lookup table for "segment" and "prediction" (-1 otherwise).
 */

/**
 * Convert hiragana to full-width katakana (other characters are kept).
 * @param {string} text - Text
 * @returns {string} Katakana text
 * @example
 * toKatakana('きょうはー') // "キョウハー"
 */
export const toKatakana = (text) => text.replace(/[ぁ-ゖゝゞ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

/**
 * Merge anthy's results into the candidate list shown while typing, in this order:
 * the whole-sentence conversion, the first segment's candidates, predictions, the hiragana reading,
 * and the full-width katakana reading. Empty strings and duplicates are dropped (first one wins).
 * @param {object} parts - Parts
 * @param {string} parts.reading - Hiragana reading being composed
 * @param {string} [parts.whole] - Whole-sentence conversion (first candidate of every segment)
 * @param {string[]} [parts.segment] - First segment's lookup table
 * @param {string[]} [parts.predictions] - Prediction lookup table
 * @returns {LiveCandidate[]} Ordered, de-duplicated candidates
 * @example
 * mergeCandidates({ reading: 'かんじ', whole: '漢字', segment: ['漢字', '感じ'] }).map((c) => c.text)
 * // ["漢字", "感じ", "かんじ", "カンジ"]
 */
export const mergeCandidates = ({ reading, whole = '', segment = [], predictions = [] }) => {
  const seen = new Set();
  /** @type {LiveCandidate[]} */
  const list = [];
  /**
   * Add a candidate unless it is empty or already listed.
   * @param {string} text - Candidate text
   * @param {CandidateKind} kind - Where it came from
   * @param {number} index - Lookup table index, or -1
   * @returns {void}
   * @example
   * add('漢字', 'whole', -1)
   */
  const add = (text, kind, index) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    list.push({ text, kind, index });
  };
  add(whole, 'whole', -1);
  segment.forEach((text, i) => add(text, 'segment', i));
  predictions.forEach((text, i) => add(text, 'prediction', i));
  add(reading, 'hiragana', -1);
  add(toKatakana(reading), 'katakana', -1);
  return list;
};

/**
 * Create a debouncer: `schedule(fn)` runs fn after `delayMs` of quiet; scheduling again restarts
 * the wait, and `cancel()` drops the pending call.
 * @param {object} options - Options
 * @param {number} options.delayMs - Quiet time before running
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer=setTimeout] - Timer (injectable for tests)
 * @param {(id: unknown) => void} [options.clearTimer=clearTimeout] - Timer cancel
 * @returns {{schedule: (fn: () => void) => void, cancel: () => void, readonly pending: boolean}} The debouncer
 * @example
 * const d = createDebouncer({ delayMs: 150 });
 * d.schedule(() => console.log('quiet'));
 */
export const createDebouncer = ({ delayMs, setTimer = setTimeout, clearTimer = clearTimeout }) => {
  let id = null;

  /**
   * Drop the pending call.
   * @returns {void}
   * @example
   * cancel()
   */
  const cancel = () => {
    if (id !== null) clearTimer(id);
    id = null;
  };

  /**
   * Run fn after the quiet time, replacing any pending call.
   * @param {() => void} fn - Function to run
   * @returns {void}
   * @example
   * schedule(() => {})
   */
  const schedule = (fn) => {
    cancel();
    id = setTimer(() => {
      id = null;
      fn();
    }, delayMs);
  };

  return {
    schedule,
    cancel,
    get pending() {
      return id !== null;
    },
  };
};

/**
 * Create a generation counter. Every input bumps it; a background job remembers the generation it
 * started in and stops (or throws its result away) once the counter has moved on.
 * @returns {{bump: () => number, readonly current: number, isCurrent: (gen: number) => boolean}} The counter
 * @example
 * const gen = createGeneration();
 * const mine = gen.current;
 * gen.bump();
 * gen.isCurrent(mine) // false
 */
export const createGeneration = () => {
  let current = 0;
  return {
    /**
     * Start a new generation.
     * @returns {number} The new generation
     * @example
     * bump()
     */
    bump: () => {
      current += 1;
      return current;
    },
    get current() {
      return current;
    },
    /**
     * Check whether a generation is still the latest.
     * @param {number} gen - Generation to check
     * @returns {boolean} True when nothing happened since
     * @example
     * isCurrent(3)
     */
    isCurrent: (gen) => gen === current,
  };
};
