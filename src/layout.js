// Key layouts of every page. Pure data. Each row is a list of keys; `w` is the key's width weight
// inside its row (rows are laid out as flex rows filling the panel width).
//
// kana (from the design doc):          qwerty (arranged like a PC keyboard):
//  ↶    あ    か    さ    ⌫            esc q w e r t y u i o p ⌫    (flick up: 1 2 3 4 5 6 7 8 9 0)
//  ←    た    な    は    →               a s d f g h j k l  ⏎     (flick up: @ # $ % & - + ( ))
//  ☺記  ま    や    ら    空白           ⇧  z x c v b n m , .  ⇧   (flick up: * " ' : ; ! ? ! ?)
//  あA  ゛゜小 わ   、。?! ⏎            ctrl alt 123   space   あA ← →
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

/*
 * QWERTY and number pages share one grid: every row adds up to ROW_WIDTH key widths, with ⌫ at the
 * right end of the top row and ⏎ at the right end of the second, so those keys (and the whole bottom
 * row) stay put when the page changes. Letters are 1 wide (the q row has 12 keys: esc, 10 letters, ⌫).
 */
const ROW_WIDTH = 11.9;
const ESC_W = 0.8;
const BACKSPACE_W = 1.1;
const ENTER_W = 1.6;
/** Where the a row starts: half a key right of q (esc + 0.5), like a real keyboard. */
const A_ROW_INDENT = ESC_W + 0.5;
/** Left ⇧: the z row starts another half key to the right. */
const SHIFT_W = A_ROW_INDENT + 0.5;

/** The bottom row shared by the QWERTY and number pages (as on a PC: Ctrl and Alt at the left). */
const QWERTY_BOTTOM = Object.freeze([
  action('ctrl', 'ctrl', { w: 1.2 }),
  action('alt', 'alt', { w: 1.2 }),
  action('num', '123', { w: 1.3 }),
  action('space', 'space', { w: 4.2 }),
  action('mode', 'あA', { w: 1.4, long: 'stock' }),
  action('left', '←', { w: 1.3, repeat: true }),
  action('right', '→', { w: 1.3, repeat: true }),
]);

/**
 * ⌫ for the right end of a top row.
 * @returns {KeyDef} Key definition
 * @example
 * backspaceKey()
 */
const backspaceKey = () => action('backspace', '⌫', { w: BACKSPACE_W, repeat: true });

/**
 * ⏎ for the right end of a second row.
 * @returns {KeyDef} Key definition
 * @example
 * enterKey()
 */
const enterKey = () => action('enter', '⏎', { w: ENTER_W });

/**
 * Give keys equal widths that fill the rest of a row.
 * @param {KeyDef[]} keys - Keys to size
 * @param {number} rest - Width left for them
 * @returns {KeyDef[]} Resized copies
 * @example
 * fill(chars('1234567890'), ROW_WIDTH - BACKSPACE_W)
 */
const fill = (keys, rest) => keys.map((k) => ({ ...k, w: rest / keys.length }));

/**
 * Copy the shared bottom row, replacing the 123 key.
 * @param {KeyDef} pageKey - Key that takes the place of "123"
 * @returns {KeyDef[]} Row
 * @example
 * bottomRow(action('qwerty', 'ABC', { w: 1.3 }))
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
  // 11 key widths per row: Esc takes one at the left of the q row, and the rows below keep the
  // same key size (a sits half a key right of q, z a whole key).
  qwerty: [
    [action('esc', 'esc', { w: ESC_W }), ...letters('qwertyuiop', '1234567890'), backspaceKey()],
    [spacer(A_ROW_INDENT), ...letters('asdfghjkl', '@#$%&-+()'), enterKey()],
    [
      action('shift', '⇧', { w: SHIFT_W }),
      ...letters('zxcvbnm', '*"\':;!?'),
      char(',', { up: '!' }),
      char('.', { up: '?' }),
      action('shift', '⇧', { w: ROW_WIDTH - SHIFT_W - 9 }),
    ],
    [...QWERTY_BOTTOM],
  ],
  num: [
    [...fill(chars('1234567890'), ROW_WIDTH - BACKSPACE_W), backspaceKey()],
    [...fill(chars('@#$%&-+()/'), ROW_WIDTH - ENTER_W), enterKey()],
    [action('num2', '#+=', { w: SHIFT_W }), ...fill(chars('*"\':;!?,.'), ROW_WIDTH - SHIFT_W)],
    bottomRow(action('qwerty', 'ABC', { w: 1.3 })),
  ],
  num2: [
    [...fill(chars('[]{}#%^*+='), ROW_WIDTH - BACKSPACE_W), backspaceKey()],
    [...fill(chars('_\\|~<>`€£¥'), ROW_WIDTH - ENTER_W), enterKey()],
    [action('num', '123', { w: SHIFT_W }), ...fill(chars('.,?!\'/:'), ROW_WIDTH - SHIFT_W)],
    bottomRow(action('qwerty', 'ABC', { w: 1.3 })),
  ],
  sym1: symbolPage(SYMBOLS_1),
  sym2: symbolPage(SYMBOLS_2),
});
