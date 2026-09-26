// The ゛゜小 key: cycles the previous character through its voiced / semi-voiced / small forms.

/** Each group cycles in order and wraps around (e.g. は → ば → ぱ → は). */
const CYCLES = [
  'あぁ', 'いぃ', 'うぅゔ', 'えぇ', 'おぉ',
  'かが', 'きぎ', 'くぐ', 'けげ', 'こご',
  'さざ', 'しじ', 'すず', 'せぜ', 'そぞ',
  'ただ', 'ちぢ', 'つっづ', 'てで', 'とど',
  'はばぱ', 'ひびぴ', 'ふぶぷ', 'へべぺ', 'ほぼぽ',
  'やゃ', 'ゆゅ', 'よょ',
  'わゎ',
];

/** @type {ReadonlyMap<string, string>} */
const NEXT = new Map(
  CYCLES.flatMap((group) => {
    const chars = Array.from(group);
    return chars.map((ch, i) => [ch, chars[(i + 1) % chars.length]]);
  }),
);

/**
 * Return the next form of a character in its ゛゜小 cycle.
 * @param {string|undefined|null} ch - The previous character
 * @returns {string|null} The next form, or null when the character has no variants
 * @example
 * cycleModifier('か') // "が"
 * cycleModifier('ぱ') // "は"
 * cycleModifier('ん') // null
 */
export const cycleModifier = (ch) => (ch ? NEXT.get(ch) ?? null : null);
