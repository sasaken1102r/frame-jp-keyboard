// Kana -> romaji keystrokes for ibus-anthy in romaji typing mode, plus the X keysyms we send.
// Pure data and lookups, no IBus objects.
//
// Every kana maps to a complete, unambiguous romaji sequence, so anthy never holds a pending
// consonant between our key events: ん is "nn", small kana use the x- prefix, っ is "xtu".
// Verified on the device (ibus-anthy, default romaji table): "vudiduxwawo-[],.?!xtuxaxyaxyuxyo"
// becomes "ヴぢづゎをー「」、。？！っぁゃゅょ", and "konnnitiha" becomes "こんにちは".

/** X keysym values used with IBus process_key_event. Printable ASCII keysyms equal their char code. */
export const KEYSYM = Object.freeze({
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Left: 0xff51,
  Right: 0xff53,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  space: 0x20,
});

/** IBus modifier mask for Shift (IBus.ModifierType.SHIFT_MASK). */
export const SHIFT_MASK = 1;

/** Rows of kana and their romaji, grouped by consonant. */
const ROWS = [
  ['あいうえお', ['a', 'i', 'u', 'e', 'o']],
  ['かきくけこ', ['ka', 'ki', 'ku', 'ke', 'ko']],
  ['がぎぐげご', ['ga', 'gi', 'gu', 'ge', 'go']],
  ['さしすせそ', ['sa', 'si', 'su', 'se', 'so']],
  ['ざじずぜぞ', ['za', 'zi', 'zu', 'ze', 'zo']],
  ['たちつてと', ['ta', 'ti', 'tu', 'te', 'to']],
  ['だぢづでど', ['da', 'di', 'du', 'de', 'do']],
  ['なにぬねの', ['na', 'ni', 'nu', 'ne', 'no']],
  ['はひふへほ', ['ha', 'hi', 'hu', 'he', 'ho']],
  ['ばびぶべぼ', ['ba', 'bi', 'bu', 'be', 'bo']],
  ['ぱぴぷぺぽ', ['pa', 'pi', 'pu', 'pe', 'po']],
  ['まみむめも', ['ma', 'mi', 'mu', 'me', 'mo']],
  ['やゆよ', ['ya', 'yu', 'yo']],
  ['らりるれろ', ['ra', 'ri', 'ru', 're', 'ro']],
  ['わをん', ['wa', 'wo', 'nn']],
  ['ぁぃぅぇぉ', ['xa', 'xi', 'xu', 'xe', 'xo']],
  ['ゃゅょゎっ', ['xya', 'xyu', 'xyo', 'xwa', 'xtu']],
  // anthy turns "vu" into katakana ヴ; both map back to "vu".
  ['ゔヴ', ['vu', 'vu']],
  // Punctuation in anthy's default hiragana mode (period-style 0: 、。).
  ['ー、。？！「」，．', ['-', ',', '.', '?', '!', '[', ']', ',', '.']],
];

/** @type {ReadonlyMap<string, string>} */
const ROMAJI = new Map(
  ROWS.flatMap(([kana, romaji]) => Array.from(kana).map((ch, i) => [ch, romaji[i]])),
);

/**
 * Get the romaji keystrokes that make anthy produce one kana character.
 * @param {string} ch - One character
 * @returns {string|null} Romaji, or null when the character cannot be typed through anthy
 * @example
 * kanaToRomaji('ん') // "nn"
 * kanaToRomaji('っ') // "xtu"
 * kanaToRomaji('漢') // null
 */
export const kanaToRomaji = (ch) => ROMAJI.get(ch) ?? null;

/**
 * Check whether every character of a string can be typed through anthy.
 * @param {string} text - Text
 * @returns {boolean} True when all characters have romaji
 * @example
 * isTypable('かんじ') // true
 * isTypable('A') // false
 */
export const isTypable = (text) => Array.from(text).every((ch) => ROMAJI.has(ch));

/**
 * @typedef {{keyval: number, state: number}} KeyStroke
 */

/**
 * Build a key stroke.
 * @param {number} keyval - X keysym
 * @param {number} [state=0] - Modifier mask
 * @returns {KeyStroke} The stroke
 * @example
 * stroke(KEYSYM.Return) // {keyval: 65293, state: 0}
 */
export const stroke = (keyval, state = 0) => ({ keyval, state });

/**
 * Convert kana text into the key strokes that type it through anthy.
 * Characters without romaji are skipped and reported.
 * @param {string} text - Kana text
 * @returns {{strokes: KeyStroke[], skipped: string[]}} Strokes and the characters that were skipped
 * @example
 * textToStrokes('かん').strokes.map((s) => String.fromCharCode(s.keyval)).join('') // "kann"
 */
export const textToStrokes = (text) => {
  const strokes = [];
  const skipped = [];
  for (const ch of Array.from(text)) {
    const romaji = kanaToRomaji(ch);
    if (romaji === null) {
      skipped.push(ch);
      continue;
    }
    for (const c of romaji) strokes.push(stroke(c.charCodeAt(0)));
  }
  return { strokes, skipped };
};

/**
 * The digit key that picks candidate `indexInPage` on the current lookup-table page (1..9, then 0).
 * @param {number} indexInPage - Zero-based index within the page (0..9)
 * @returns {KeyStroke} The stroke
 * @example
 * digitStroke(0).keyval // 0x31 ("1")
 * digitStroke(9).keyval // 0x30 ("0")
 */
export const digitStroke = (indexInPage) => stroke(0x30 + ((indexInPage + 1) % 10));
