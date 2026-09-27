// Our copy of the kana being composed (before conversion), with a caret. Pure logic.
//
// The composer describes edits relative to the cursor ({text}, Backspace, ArrowLeft/Right). We apply
// them here; conversion reads the resulting text directly (libanthy accepts any character, so
// symbols such as ～ stay in the reading).

/**
 * @typedef {{chars: string[], caret: number}} Mirror
 * @typedef {import('./composer.js').OutputOp} OutputOp
 */

/** @type {Readonly<Mirror>} */
export const EMPTY_MIRROR = Object.freeze({ chars: [], caret: 0 });

/**
 * Create a mirror holding `text` with the caret at its end.
 * @param {string} text - Kana text
 * @returns {Mirror} The mirror
 * @example
 * mirrorOf('かな') // {chars:["か","な"], caret:2}
 */
export const mirrorOf = (text) => {
  const chars = Array.from(text);
  return { chars, caret: chars.length };
};

/**
 * Apply composer operations to the mirror.
 * Moves past either end are dropped, like a text field would ignore them.
 * @param {Mirror} mirror - Current mirror (not modified)
 * @param {OutputOp[]} ops - Operations from the composer
 * @returns {{mirror: Mirror}} The new mirror
 * @example
 * mirrorText(applyOps(mirrorOf('か'), [{ key: 'Backspace' }, { text: 'が' }]).mirror) // "が"
 */
export const applyOps = (mirror, ops) => {
  const chars = [...mirror.chars];
  let caret = mirror.caret;
  for (const op of ops) {
    if ('text' in op) {
      for (const ch of Array.from(op.text)) {
        chars.splice(caret, 0, ch);
        caret += 1;
      }
    } else if (op.key === 'Backspace') {
      if (caret > 0) {
        chars.splice(caret - 1, 1);
        caret -= 1;
      }
    } else if (op.key === 'ArrowLeft') {
      if (caret > 0) caret -= 1;
    } else if (op.key === 'ArrowRight') {
      if (caret < chars.length) caret += 1;
    }
  }
  return { mirror: { chars, caret } };
};

/**
 * Get the mirror's text.
 * @param {Mirror} mirror - Mirror
 * @returns {string} Text
 * @example
 * mirrorText(mirrorOf('あい')) // "あい"
 */
export const mirrorText = (mirror) => mirror.chars.join('');
