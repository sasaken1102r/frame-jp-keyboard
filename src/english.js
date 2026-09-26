// English word suggestions for the QWERTY keyboard. Pure logic, no DOM and no Steam objects.
//
// Delivery: letters are committed to the target immediately (like the stock keyboard), and we only
// remember the current word we typed ourselves. Tapping a suggestion sends Backspace x the word's
// length, then the suggestion and a space. Nothing is ever replaced without a tap.

/** How much of the text before the cursor the tracker remembers. */
const KNOWN_MAX = 64;
const LETTERS = "abcdefghijklmnopqrstuvwxyz'";

/**
 * Decode the front-coded word list from src/data/words-en.js into rank order.
 * Bands are separated by "|"; in a band, entries are "<shared prefix length in base 36><suffix>"
 * in alphabetical order. Within a band, shorter words rank first, then alphabetical.
 * @param {string} encoded - Encoded list
 * @returns {string[]} Words, most frequent first
 * @example
 * decodeWords('0the|0help,3lo') // ["the", "help", "hello"]
 */
export const decodeWords = (encoded) => encoded.split('|').flatMap((band) => {
  let previous = '';
  const words = [];
  for (const entry of band.split(',')) {
    if (!entry) continue;
    const word = previous.slice(0, parseInt(entry[0], 36)) + entry.slice(1);
    words.push(word);
    previous = word;
  }
  return words.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
});

/**
 * @typedef {object} Dictionary
 * @property {Map<string, {word: string, rank: number}>} byLower - Lower-case word -> best entry
 * @property {string[]} sorted - Lower-case words in alphabetical order (for prefix search)
 */

/**
 * Build the lookup structures for a ranked word list.
 * @param {string[]} words - Words, most frequent first
 * @returns {Dictionary} The dictionary
 * @example
 * createDictionary(['the', 'help']).byLower.get('help').rank // 1
 */
export const createDictionary = (words) => {
  const byLower = new Map();
  words.forEach((word, rank) => {
    const lower = word.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, { word, rank });
  });
  return { byLower, sorted: [...byLower.keys()].sort() };
};

/**
 * Index of the first sorted word that is >= key.
 * @param {string[]} sorted - Sorted words
 * @param {string} key - Search key
 * @returns {number} Index
 * @example
 * lowerBound(['a', 'b', 'c'], 'b') // 1
 */
const lowerBound = (sorted, key) => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * All strings at edit distance 1 (delete, transpose, replace, insert).
 * @param {string} word - Lower-case word
 * @returns {Set<string>} Edits
 * @example
 * edits1('helo').has('hello') // true
 */
export const edits1 = (word) => {
  const out = new Set();
  for (let i = 0; i <= word.length; i += 1) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    if (right) out.add(left + right.slice(1));
    if (right.length > 1) out.add(left + right[1] + right[0] + right.slice(2));
    for (const c of LETTERS) {
      if (right) out.add(left + c + right.slice(1));
      out.add(left + c + right);
    }
  }
  out.delete(word);
  return out;
};

/**
 * Apply the input's case to a suggestion: "Hel" -> "Hello", "HEL" -> "HELLO", "hel" -> dictionary case.
 * @param {string} typed - What the user typed
 * @param {string} word - Suggestion in dictionary case
 * @returns {string} Suggestion in the input's case
 * @example
 * matchCase('HEL', 'hello') // "HELLO"
 * matchCase('Hel', 'hello') // "Hello"
 * matchCase('i', 'I') // "I"
 */
export const matchCase = (typed, word) => {
  const letters = typed.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return word.toUpperCase();
  if (/^[A-Z]/.test(typed)) return word[0].toUpperCase() + word.slice(1);
  return word;
};

/** QWERTY rows, for "the neighbouring key was hit" typos. */
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** @type {ReadonlyMap<string, ReadonlySet<string>>} Letter -> keys around it on QWERTY */
const NEIGHBOURS = new Map(ROWS.flatMap((row, r) => Array.from(row).map((ch, c) => {
  const near = [row[c - 1], row[c + 1], ROWS[r - 1]?.[c], ROWS[r - 1]?.[c + 1], ROWS[r + 1]?.[c - 1], ROWS[r + 1]?.[c]];
  return [ch, new Set(near.filter(Boolean))];
})));

/**
 * Cost of each kind of single-edit typo (lower = more likely).
 * Doubled letters and swaps are the most common slips; a neighbouring key is next.
 */
const EDIT_COST = Object.freeze({ double: 0, transpose: 0.5, neighbour: 1, insert: 1.5, delete: 1.5, replace: 2 });

/**
 * All strings at edit distance 1 with the kind of edit that produced them (cheapest kind kept).
 * @param {string} word - Lower-case word
 * @returns {Map<string, number>} Candidate -> edit cost
 * @example
 * scoredEdits1('helo').get('hello') // 0 (doubled letter)
 */
export const scoredEdits1 = (word) => {
  const out = new Map();
  /**
   * Record a candidate with a cost, keeping the cheapest.
   * @param {string} candidate - Candidate string
   * @param {number} cost - Edit cost
   * @returns {void}
   * @example
   * put('hello', 0)
   */
  const put = (candidate, cost) => {
    if (candidate !== word && !(out.get(candidate) <= cost)) out.set(candidate, cost);
  };
  for (let i = 0; i <= word.length; i += 1) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    if (right) put(left + right.slice(1), EDIT_COST.delete);
    if (right.length > 1) put(left + right[1] + right[0] + right.slice(2), EDIT_COST.transpose);
    for (const c of LETTERS) {
      if (right) put(left + c + right.slice(1), NEIGHBOURS.get(right[0])?.has(c) ? EDIT_COST.neighbour : EDIT_COST.replace);
      const doubled = c === left.at(-1) || c === right[0];
      put(left + c + right, doubled ? EDIT_COST.double : EDIT_COST.insert);
    }
  }
  return out;
};

/**
 * Spelling corrections: dictionary words at edit distance 1 scored by frequency and typo kind, or
 * at distance 2 (frequency only) when distance 1 finds nothing.
 * @param {Dictionary} dict - Dictionary
 * @param {string} lower - Lower-case typed word
 * @returns {{word: string, rank: number}[]} Best corrections first
 * @example
 * correctionsFor(dict, 'helo').map((e) => e.word) // ["help", "hell", "hello", ...]
 */
export const correctionsFor = (dict, lower) => {
  const one = scoredEdits1(lower);
  const scored = [];
  for (const [candidate, cost] of one) {
    const entry = dict.byLower.get(candidate);
    if (entry) scored.push({ entry, score: Math.log2(entry.rank + 2) + cost * 2 });
  }
  if (scored.length === 0 && lower.length >= 3 && lower.length <= 10) {
    const seen = new Set();
    for (const e of one.keys()) {
      for (const e2 of edits1(e)) {
        const entry = dict.byLower.get(e2);
        if (entry && e2 !== lower && !seen.has(e2)) {
          seen.add(e2);
          scored.push({ entry, score: Math.log2(entry.rank + 2) + 8 });
        }
      }
    }
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.entry);
};

/**
 * @typedef {{text: string, kind: 'completion'|'typed'|'correction'}} Suggestion
 */

/**
 * Suggest words for the word being typed: prefix completions by frequency, then the typed string
 * as-is, then (when there are few completions) spelling corrections at edit distance 1, or 2 when
 * distance 1 finds nothing.
 * @param {Dictionary} dict - Dictionary
 * @param {string} typed - Current word as typed
 * @param {object} [options] - Limits
 * @param {number} [options.completions=6] - Max completions
 * @param {number} [options.corrections=3] - Max corrections
 * @param {number} [options.fewCompletions=3] - Look for corrections below this many completions
 * @returns {Suggestion[]} Suggestions (empty when nothing is typed)
 * @example
 * suggest(dict, 'helo').map((s) => s.text) // ["helot", "helo", "help", "hello", ...]
 */
export const suggest = (dict, typed, { completions = 6, corrections = 3, fewCompletions = 3 } = {}) => {
  if (!typed) return [];
  const lower = typed.toLowerCase();
  const seen = new Set([typed]);
  /** @type {Suggestion[]} */
  const out = [];
  /**
   * Add a suggestion unless it is already listed.
   * @param {string} text - Text
   * @param {Suggestion['kind']} kind - Kind
   * @returns {void}
   * @example
   * add('hello', 'completion')
   */
  const add = (text, kind) => {
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ text, kind });
  };

  const found = [];
  for (let i = lowerBound(dict.sorted, lower); i < dict.sorted.length && dict.sorted[i].startsWith(lower); i += 1) {
    const entry = dict.byLower.get(dict.sorted[i]);
    // The typed word itself only counts as a completion when its case differs ("i" -> "I").
    if (dict.sorted[i] === lower && matchCase(typed, entry.word) === typed) continue;
    found.push(entry);
  }
  found.sort((a, b) => a.rank - b.rank);
  for (const entry of found.slice(0, completions)) add(matchCase(typed, entry.word), 'completion');
  const completionCount = out.length;

  out.push({ text: typed, kind: 'typed' });

  if (completionCount < fewCompletions && lower.length >= 2) {
    const fixes = correctionsFor(dict, lower);
    for (const entry of fixes.slice(0, corrections)) add(matchCase(typed, entry.word), 'correction');
  }
  return out;
};

/**
 * Track the word being typed from what we send to the target, and whether a sentence just ended.
 * Only text we typed ourselves is known; anything we cannot follow (arrows, deleting past the
 * word) makes the tracker forget, so a suggestion never deletes text it has not seen.
 * @returns {{
 *   observe: (ops: ({text: string}|{key: string})[]) => void,
 *   reset: () => void,
 *   readonly word: string,
 *   readonly sentenceStart: boolean,
 * }} The tracker
 * @example
 * const t = createWordTracker();
 * t.observe([{ text: 'Hi. he' }]);
 * t.word // "he"
 */
export const createWordTracker = () => {
  /** Text we know sits right before the cursor (null = unknown), newest last. */
  let known = null;

  /**
   * Append typed characters to the known text.
   * @param {string} text - Characters
   * @returns {void}
   * @example
   * append('a')
   */
  const append = (text) => {
    known = `${known ?? ''}${text}`.slice(-KNOWN_MAX);
  };

  /**
   * Follow operations sent to the target.
   * @param {({text: string}|{key: string})[]} ops - Output operations
   * @returns {void}
   * @example
   * observe([{ key: 'Backspace' }])
   */
  const observe = (ops) => {
    for (const op of ops) {
      if ('text' in op) append(op.text);
      else if (op.key === 'Backspace') known = known ? Array.from(known).slice(0, -1).join('') : null;
      else if (op.key === 'Enter') known = '\n';
      else known = null;
    }
  };

  /**
   * Forget everything (keyboard opened, cursor moved elsewhere).
   * @returns {void}
   * @example
   * reset()
   */
  const reset = () => {
    known = null;
  };

  return {
    observe,
    reset,
    get word() {
      return known ? (/[A-Za-z']+$/.exec(known)?.[0] ?? '') : '';
    },
    get sentenceStart() {
      return known !== null && /(?:[.!?]\s+|\n\s*)$/.test(known);
    },
  };
};
