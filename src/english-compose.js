// The English word being typed on the QWERTY keyboard, kept locally until it is committed (like
// the kana preedit, but without IBus). Pure logic: edits return no output; commits return the
// output operations for the target.

/**
 * @typedef {import('./composer.js').OutputOp} OutputOp
 */

/** Characters that belong to an English word (so "don't" stays one word). */
const WORD_CHAR = /^[A-Za-z']$/;

/**
 * Whether a character continues the word being composed.
 * @param {string} ch - One character
 * @returns {boolean} True for letters and the apostrophe
 * @example
 * isWordChar("'") // true
 * isWordChar('.') // false
 */
export const isWordChar = (ch) => WORD_CHAR.test(ch);

/**
 * Create the English composition.
 * @returns {{
 *   input: (ch: string) => void,
 *   backspace: () => OutputOp[],
 *   arrow: (direction: 'left'|'right') => OutputOp[],
 *   commit: (suffix?: string) => OutputOp[],
 *   commitAs: (text: string, suffix?: string) => OutputOp[],
 *   readonly word: string,
 *   readonly caret: number,
 * }} The composition
 * @example
 * const en = createEnglishComposition();
 * en.input('h'); en.input('i');
 * en.commit(' ') // [{ text: "hi " }]
 */
export const createEnglishComposition = () => {
  /** @type {string[]} */
  let chars = [];
  let caret = 0;

  /**
   * Take the word and clear the composition.
   * @returns {string} The word
   * @example
   * take()
   */
  const take = () => {
    const word = chars.join('');
    chars = [];
    caret = 0;
    return word;
  };

  /**
   * Insert a letter at the caret.
   * @param {string} ch - The letter (already in the case to type)
   * @returns {void}
   * @example
   * input('a')
   */
  const input = (ch) => {
    chars.splice(caret, 0, ch);
    caret += 1;
  };

  /**
   * ⌫: delete before the caret, or pass Backspace through when nothing is composed.
   * @returns {OutputOp[]} Output (empty while editing the composition)
   * @example
   * backspace()
   */
  const backspace = () => {
    if (!chars.length) return [{ key: 'Backspace' }];
    if (caret > 0) {
      chars.splice(caret - 1, 1);
      caret -= 1;
    }
    return [];
  };

  /**
   * ← / →: move the caret in the composition, or pass the key through when nothing is composed.
   * @param {'left'|'right'} direction - Direction
   * @returns {OutputOp[]} Output (empty while editing the composition)
   * @example
   * arrow('left')
   */
  const arrow = (direction) => {
    if (!chars.length) return [{ key: direction === 'left' ? 'ArrowLeft' : 'ArrowRight' }];
    caret = direction === 'left' ? Math.max(0, caret - 1) : Math.min(chars.length, caret + 1);
    return [];
  };

  /**
   * Commit the word as typed, followed by a suffix (space, punctuation, symbol).
   * @param {string} [suffix=''] - Text after the word
   * @returns {OutputOp[]} One text operation, or none when there is nothing to send
   * @example
   * commit('.') // [{ text: "word." }]
   */
  const commit = (suffix = '') => {
    const text = take() + suffix;
    return text ? [{ text }] : [];
  };

  /**
   * Commit a suggestion in place of the word, followed by a suffix.
   * @param {string} text - The suggestion
   * @param {string} [suffix=' '] - Text after it
   * @returns {OutputOp[]} One text operation
   * @example
   * commitAs('hello') // [{ text: "hello " }]
   */
  const commitAs = (text, suffix = ' ') => {
    take();
    return [{ text: text + suffix }];
  };

  return {
    input,
    backspace,
    arrow,
    commit,
    commitAs,
    get word() {
      return chars.join('');
    },
    get caret() {
      return caret;
    },
  };
};
