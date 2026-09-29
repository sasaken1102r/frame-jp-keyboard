// How output operations are split into VirtualKeyboardManager.HandleVirtualKeyDown calls. Pure logic.
//
// Minimal mode: Steam delivers the text to apps through gamescope's input method, which gives each
// character that the current keymap cannot type a temporary keycode and keymap. Each call means one
// keymap change, so a run of non-ASCII text (kana, kanji) goes out as a single call. ASCII characters
// stay one call each: gamescope types them from the normal keymap without changing it.
//
// Buffered VR mode: the VR keyboard keeps its own text buffer and moves its cursor by one character
// per call, so there we send one grapheme per call and let it update in between (see steam.js).

/** Printable ASCII: typed from the default keymap. */
const ASCII = /^[\x20-\x7e]$/;

/**
 * Split text into user-perceived characters (graphemes), like Steam's buffer does.
 * @param {string} text - Text
 * @returns {string[]} Graphemes
 * @example
 * graphemes('が👍🏽') // ["が", "👍🏽"]
 */
export const graphemes = (text) => {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
};

/**
 * Plan the HandleVirtualKeyDown calls for output operations. Key chords ({keys}, see key-chords.js)
 * are not HandleVirtualKeyDown calls; they pass through in order as they are.
 * @param {({text: string}|{key: string}|{keys: [number, boolean][]})[]} ops - Output operations
 * @param {{buffered: boolean}} mode - Whether the VR keyboard is in buffered mode
 * @returns {(string|{keys: [number, boolean][]})[]} One string per call (key names such as
 *   "Backspace" stay as they are), and the chords
 * @example
 * planCalls([{ text: 'かんじ' }], { buffered: false }) // ["かんじ"]
 * planCalls([{ text: 'hi' }], { buffered: false }) // ["h", "i"]
 * planCalls([{ text: 'かんじ' }], { buffered: true }) // ["か", "ん", "じ"]
 */
export const planCalls = (ops, { buffered }) => {
  const calls = [];
  for (const op of ops) {
    if ('key' in op) {
      calls.push(op.key);
      continue;
    }
    if ('keys' in op) {
      calls.push({ keys: op.keys });
      continue;
    }
    const parts = graphemes(op.text);
    if (buffered) {
      calls.push(...parts);
      continue;
    }
    /** @type {string[]} */
    let run = [];
    /**
     * Emit the pending non-ASCII run as one call.
     * @returns {void}
     * @example
     * flushRun()
     */
    const flushRun = () => {
      if (run.length) calls.push(run.join(''));
      run = [];
    };
    for (const part of parts) {
      if (ASCII.test(part)) {
        flushRun();
        calls.push(part);
      } else {
        run.push(part);
      }
    }
    flushRun();
  }
  return calls;
};
