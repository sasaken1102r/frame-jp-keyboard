// Key layouts of every page. Pure data. Each row is a list of keys; `w` is the key's width weight
// inside its row (rows are laid out as flex rows filling the panel width).
//
// kana (from the design doc):          qwerty:
//  ↶    あ    か    さ    ⌫            q w e r t y u i o p      (flick up: 1 2 3 4 5 6 7 8 9 0)
//  ←    た    な    は    →             a s d f g h j k l       (flick up: @ # $ % & - + ( ))
//  ☺記  ま    や    ら    空白          ⇧ z x c v b n m ⌫       (flick up: * " ' : ; ! ?)
//  あA  ゛゜小 わ   、。?! ⏎            あA 123 , ← ␣ → . ⏎
import { KANA_KEYS } from './kana-table.js';

/**
 * @typedef {object} KeyDef
 * @property {'kana'|'char'|'action'|'spacer'} type - Kana keys flick; char keys type a character (flick up = `up`); action keys fire once (or repeat)
 * @property {string} id - Kana key id, action id, or the character for char keys
 * @property {string} label - Text shown on the key
 * @property {number} w - Width weight within the row
 * @property {string} [ch] - Character typed by a char key
 * @property {string} [up] - Character typed by flicking a char key up
 * @property {boolean} [letter] - Char key affected by shift
 * @property {boolean} [symbol] - Char key on a symbol page (styled smaller)
 * @property {boolean} [repeat] - Auto-repeat while held
 * @property {string} [long] - Action fired by a long press instead of the tap action
 * @property {boolean} [side] - Styled as a function key
 */

/**
 * Build a kana key definition.
 * @param {string} id - Kana key id
 * @param {number} [w=1.35] - Width weight
 * @returns {KeyDef} Key definition
 * @example
 * kana('ka') // {type:"kana", id:"ka", label:"か", w:1.35}
 */
const kana = (id, w = 1.35) => ({ type: 'kana', id, label: KANA_KEYS[id].label, w });

/**
 * Build an action key definition.
 * @param {string} id - Action id
 * @param {string} label - Key label
 * @param {Partial<KeyDef>} [extra] - Extra properties
 * @returns {KeyDef} Key definition
 * @example
 * action('enter', '⏎', { w: 1.75 })
 */
const action = (id, label, extra = {}) => ({ type: 'action', id, label, w: 1, side: true, ...extra });

/**
 * Build a character key definition.
 * @param {string} ch - Character typed on tap
 * @param {Partial<KeyDef>} [extra] - Extra properties (up, w, label)
 * @returns {KeyDef} Key definition
 * @example
 * char('q', { up: '1', letter: true })
 */
const char = (ch, extra = {}) => ({ type: 'char', id: ch, ch, label: ch, w: 1, ...extra });

/**
 * Build an empty spacer.
 * @param {number} w - Width weight
 * @returns {KeyDef} Spacer definition
 * @example
 * spacer(0.5)
 */
const spacer = (w) => ({ type: 'spacer', id: '', label: '', w });

/**
 * Build a row of letter keys with flick-up characters.
 * @param {string} row - Letters of the row
 * @param {string} ups - Flick-up characters, one per letter
 * @returns {KeyDef[]} Keys
 * @example
 * letters('qw', '12')
 */
const letters = (row, ups) => Array.from(row).map((ch, i) => char(ch, { up: ups[i], letter: true }));

/**
 * Build a row of plain character keys.
 * @param {ReadonlyArray<string>|string} list - Characters
 * @param {Partial<KeyDef>} [extra] - Extra properties for every key
 * @returns {KeyDef[]} Keys
 * @example
 * chars('123')
 */
const chars = (list, extra = {}) => Array.from(list).map((ch) => char(ch, extra));

/** The bottom row shared by the QWERTY, number and symbol pages. */
const QWERTY_BOTTOM = Object.freeze([
  action('mode', 'あA', { w: 1.25, long: 'stock' }),
  action('num', '123', { w: 1.25 }),
  char(',', { up: '!' }),
  action('left', '←', { w: 0.75, repeat: true }),
  action('space', 'space', { w: 2.25 }),
  action('right', '→', { w: 0.75, repeat: true }),
  char('.', { up: '?' }),
  action('enter', '⏎', { w: 1.75 }),
]);

/**
 * Copy the shared bottom row, replacing the 123 key.
 * @param {KeyDef} pageKey - Key that takes the place of "123"
 * @returns {KeyDef[]} Row
 * @example
 * bottomRow(action('qwerty', 'ABC', { w: 1.25 }))
 */
const bottomRow = (pageKey) => QWERTY_BOTTOM.map((k) => (k.id === 'num' ? pageKey : k));

/** Japanese punctuation and brackets (☺記 page 1), 32 keys. */
export const SYMBOLS_1 = Object.freeze(Array.from('、。，．・：；？！ー〜…「」『』（）【】［］〈〉《》＜＞“”／＼'));
/** Symbols (☺記 page 2), 32 keys. */
export const SYMBOLS_2 = Object.freeze(Array.from('＠＃％＆＊＋－＝￥＄｜＿※〒♪☆★○●◎△▲□■◇◆♡→←↑↓×'));

/**
 * Build a symbol page: 4 rows of 8 symbols with page keys on the left and editing keys on the right.
 * @param {ReadonlyArray<string>} symbols - 32 symbols
 * @returns {KeyDef[][]} Rows
 * @example
 * symbolPage(SYMBOLS_1).length // 4
 */
const symbolPage = (symbols) => {
  const left = [
    action('back', 'あいう', { w: 1.3 }),
    action('sym1', '記号1', { w: 1.3 }),
    action('sym2', '記号2', { w: 1.3 }),
    action('mode', 'あA', { w: 1.3, long: 'stock' }),
  ];
  const right = [
    action('undo', '↶', { w: 1.3 }),
    action('backspace', '⌫', { w: 1.3, repeat: true }),
    action('space', '空白', { w: 1.3 }),
    action('enter', '⏎', { w: 1.3 }),
  ];
  return [0, 1, 2, 3].map((r) => [left[r], ...chars(symbols.slice(r * 8, r * 8 + 8), { symbol: true }), right[r]]);
};

/** @type {Readonly<Record<import('./keyboard-state.js').PageId, ReadonlyArray<ReadonlyArray<KeyDef>>>>} */
export const PAGES = Object.freeze({
  kana: [
    [action('undo', '↶'), kana('a'), kana('ka'), kana('sa'), action('backspace', '⌫', { repeat: true })],
    [action('left', '←', { repeat: true }), kana('ta'), kana('na'), kana('ha'), action('right', '→', { repeat: true })],
    [action('symbols', '☺記'), kana('ma'), kana('ya'), kana('ra'), action('space', '空白')],
    [action('mode', 'あA', { long: 'stock' }), action('modify', '゛゜小', { w: 1.35, side: false }), kana('wa'), kana('punct'), action('enter', '⏎')],
  ],
  qwerty: [
    letters('qwertyuiop', '1234567890'),
    [spacer(0.5), ...letters('asdfghjkl', '@#$%&-+()'), spacer(0.5)],
    [action('shift', '⇧', { w: 1.5 }), ...letters('zxcvbnm', '*"\':;!?'), action('backspace', '⌫', { w: 1.5, repeat: true })],
    [...QWERTY_BOTTOM],
  ],
  num: [
    chars('1234567890'),
    chars('@#$%&-+()/'),
    [action('num2', '#+=', { w: 1.5 }), ...chars('*"\':;!?'), action('backspace', '⌫', { w: 1.5, repeat: true })],
    bottomRow(action('qwerty', 'ABC', { w: 1.25 })),
  ],
  num2: [
    chars('[]{}#%^*+='),
    chars('_\\|~<>`€£¥'),
    [action('num', '123', { w: 1.5 }), ...chars('.,?!\'/:'), action('backspace', '⌫', { w: 1.5, repeat: true })],
    bottomRow(action('qwerty', 'ABC', { w: 1.25 })),
  ],
  sym1: symbolPage(SYMBOLS_1),
  sym2: symbolPage(SYMBOLS_2),
});
