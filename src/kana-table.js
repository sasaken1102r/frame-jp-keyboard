// The 12-key kana table in the common smartphone flick layout. Pure data and lookups.
import { DIRECTIONS } from './flick.js';

/**
 * @typedef {object} KanaKey
 * @property {string} label - Text shown on the key
 * @property {(string|null)[]} flick - Characters for [center, left, up, right, down]; null = no character
 * @property {string[]} toggle - Sequence for toggle input (repeated taps on the same key)
 */

/** @type {Readonly<Record<string, KanaKey>>} */
export const KANA_KEYS = Object.freeze({
  a: { label: 'あ', flick: ['あ', 'い', 'う', 'え', 'お'], toggle: ['あ', 'い', 'う', 'え', 'お', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ'] },
  ka: { label: 'か', flick: ['か', 'き', 'く', 'け', 'こ'], toggle: ['か', 'き', 'く', 'け', 'こ'] },
  sa: { label: 'さ', flick: ['さ', 'し', 'す', 'せ', 'そ'], toggle: ['さ', 'し', 'す', 'せ', 'そ'] },
  ta: { label: 'た', flick: ['た', 'ち', 'つ', 'て', 'と'], toggle: ['た', 'ち', 'つ', 'て', 'と', 'っ'] },
  na: { label: 'な', flick: ['な', 'に', 'ぬ', 'ね', 'の'], toggle: ['な', 'に', 'ぬ', 'ね', 'の'] },
  ha: { label: 'は', flick: ['は', 'ひ', 'ふ', 'へ', 'ほ'], toggle: ['は', 'ひ', 'ふ', 'へ', 'ほ'] },
  ma: { label: 'ま', flick: ['ま', 'み', 'む', 'め', 'も'], toggle: ['ま', 'み', 'む', 'め', 'も'] },
  ya: { label: 'や', flick: ['や', '「', 'ゆ', '」', 'よ'], toggle: ['や', 'ゆ', 'よ', 'ゃ', 'ゅ', 'ょ'] },
  ra: { label: 'ら', flick: ['ら', 'り', 'る', 'れ', 'ろ'], toggle: ['ら', 'り', 'る', 'れ', 'ろ'] },
  wa: { label: 'わ', flick: ['わ', 'を', 'ん', 'ー', '～'], toggle: ['わ', 'を', 'ん', 'ゎ', 'ー', '～'] },
  punct: { label: '、。?!', flick: ['、', '。', '？', '！', null], toggle: ['、', '。', '？', '！'] },
});

/**
 * Look up the character a flick on a kana key produces.
 * @param {string} keyId - Key id such as "ka" or "punct"
 * @param {string} direction - One of "center", "left", "up", "right", "down"
 * @returns {string|null} The character, or null when the key or direction has none
 * @example
 * getFlickChar('ka', 'up') // "く"
 * getFlickChar('wa', 'down') // "～"
 * getFlickChar('punct', 'down') // null
 */
export const getFlickChar = (keyId, direction) => {
  const key = KANA_KEYS[keyId];
  const index = DIRECTIONS.indexOf(direction);
  if (!key || index < 0) return null;
  return key.flick[index] ?? null;
};

/**
 * Get the five flick candidates of a key, keyed by direction (for the flick guide).
 * @param {string} keyId - Key id such as "a"
 * @returns {Record<string, string|null>|null} Map of direction to character, or null for an unknown key
 * @example
 * getFlickCandidates('a').left // "い"
 */
export const getFlickCandidates = (keyId) => {
  const key = KANA_KEYS[keyId];
  if (!key) return null;
  return Object.fromEntries(DIRECTIONS.map((dir, i) => [dir, key.flick[i] ?? null]));
};

/**
 * Get the toggle-input sequence of a key.
 * @param {string} keyId - Key id such as "ta"
 * @returns {string[]} The sequence, or an empty array for an unknown key
 * @example
 * getToggleSequence('ta') // ["た","ち","つ","て","と","っ"]
 */
export const getToggleSequence = (keyId) => KANA_KEYS[keyId]?.toggle ?? [];
