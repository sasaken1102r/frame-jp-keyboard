// Our copy of the kana being composed (before conversion), and the IBus key strokes that apply
// the same edit inside anthy. Pure logic, no IBus objects.
//
// The composer describes edits relative to the cursor ({text}, Backspace, ArrowLeft/Right). We apply
// them to the mirror and emit the matching strokes, so anthy's preedit and the mirror stay equal.
import { KEYSYM, stroke, textToStrokes } from './romaji.js';

/**
 * @typedef {{chars: string[], caret: number}} Mirror
 * @typedef {import('./romaji.js').KeyStroke} KeyStroke
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
 * Apply composer operations to the mirror and compute the anthy key strokes for them.
 * Moves past either end are dropped (no stroke), like a text field would ignore them.
 * @param {Mirror} mirror - Current mirror (not modified)
 * @param {OutputOp[]} ops - Operations from the composer
 * @returns {{mirror: Mirror, strokes: KeyStroke[], skipped: string[]}} New mirror, strokes, and characters that anthy cannot type
 * @example
 * applyOps(mirrorOf('か'), [{ key: 'Backspace' }, { text: 'が' }]).strokes.length // 3 (BackSpace, g, a)
 */
export const applyOps = (mirror, ops) => {
  const chars = [...mirror.chars];
  let caret = mirror.caret;
  const strokes = [];
  const skipped = [];
  for (const op of ops) {
    if ('text' in op) {
      for (const ch of Array.from(op.text)) {
        const result = textToStrokes(ch);
        if (result.skipped.length) {
          skipped.push(ch);
          continue;
        }
        chars.splice(caret, 0, ch);
        caret += 1;
        strokes.push(...result.strokes);
      }
    } else if (op.key === 'Backspace') {
      if (caret > 0) {
        chars.splice(caret - 1, 1);
        caret -= 1;
        strokes.push(stroke(KEYSYM.BackSpace));
      }
    } else if (op.key === 'ArrowLeft') {
      if (caret > 0) {
        caret -= 1;
        strokes.push(stroke(KEYSYM.Left));
      }
    } else if (op.key === 'ArrowRight') {
      if (caret < chars.length) {
        caret += 1;
        strokes.push(stroke(KEYSYM.Right));
      }
    }
  }
  return { mirror: { chars, caret }, strokes, skipped };
};

/**
 * Get the mirror's text.
 * @param {Mirror} mirror - Mirror
 * @returns {string} Text
 * @example
 * mirrorText(mirrorOf('あい')) // "あい"
 */
export const mirrorText = (mirror) => mirror.chars.join('');
