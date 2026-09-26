// Builds src/data/words-en.js, the English word list for QWERTY suggestions, from 12dicts 6.0.2
// (Alan Beale) and AGID (Kevin Atkinson); see THIRD_PARTY_LICENSES.md. Run: npm run words
//
// Ranking: 2+2+3frq.txt groups lemmas (and their irregular inflections) into 21 frequency bands
// (band 1 = most frequent; each band is half as frequent as the one before). Regular inflections
// are not in that list, so words from 2of12inf.txt get the band of their lemma plus one (lemmas of
// three or more letters only). Words
// whose lemma cannot be found are dropped, as are 2of12inf entries marked "%" (unusual plurals).
//
// Encoding (decoded by decodeWords in src/english.js): bands are joined with "|"; inside a band the
// words are sorted alphabetically and front-coded as "<shared prefix length in base 36><suffix>",
// joined with ",". Rank order at runtime = band, then shorter words first, then alphabetical.
import { readFile, writeFile } from 'node:fs/promises';

const SRC = new URL('../data/12dicts-6.0.2/', import.meta.url);
const OUT = new URL('../src/data/words-en.js', import.meta.url);
const WORD = /^[A-Za-z]+(?:'[A-Za-z]+)?$/;
const MAX_WORDS = 40000;

/**
 * Read a source file as lines without CR.
 * @param {string} name - File name inside data/12dicts-6.0.2
 * @returns {Promise<string[]>} Lines
 * @example
 * await lines('2of12inf.txt')
 */
const lines = async (name) => (await readFile(new URL(name, SRC), 'utf8')).replace(/\r/g, '').split('\n');

/**
 * Parse 2+2+3frq.txt into word -> band. Indented lines list irregular inflections of the lemma above.
 * @param {string[]} text - File lines
 * @returns {{bands: Map<string, number>, lemmaBands: Map<string, number>}} All words and lemmas only (lower case) -> band (1..21)
 * @example
 * parseFrequency(['----- 1 -----', 'be', '    am, are']).bands // Map { be => 1, am => 1, are => 1 }
 */
const parseFrequency = (text) => {
  const bands = new Map();
  const lemmaBands = new Map();
  let band = 0;
  for (const line of text) {
    const header = /^-+ (\d+) -+$/.exec(line.trim());
    if (header) {
      band = Number(header[1]);
      continue;
    }
    const isLemma = !/^\s/.test(line);
    for (const raw of line.split(',')) {
      const word = raw.trim().replace(/[*!%+~^&=<>#$@]+$/, '');
      if (!band || !WORD.test(word)) continue;
      if (!bands.has(word)) bands.set(word, band);
      if (isLemma && !lemmaBands.has(word.toLowerCase())) lemmaBands.set(word.toLowerCase(), band);
    }
  }
  return { bands, lemmaBands };
};

/**
 * Possible lemmas of a regularly inflected word.
 * @param {string} word - Inflected word (lower case)
 * @returns {string[]} Lemma candidates
 * @example
 * lemmas('stopped') // [..., 'stop', ...]
 */
const lemmas = (word) => {
  const out = [];
  /**
   * Add stem variants for a stripped suffix.
   * @param {string} stem - Word without the suffix
   * @returns {void}
   * @example
   * addStem('help')
   */
  const addStem = (stem) => {
    if (stem.length < 2) return;
    out.push(stem, `${stem}e`);
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) out.push(stem.slice(0, -1));
    if (stem.endsWith('i')) out.push(`${stem.slice(0, -1)}y`);
  };
  for (const suffix of ['ing', 'ed', 'es', 's', 'er', 'est', 'ly', 'd', 'r', 'st']) {
    if (word.endsWith(suffix)) addStem(word.slice(0, -suffix.length));
  }
  // Prefer the longest stem: "bees" is bee + s, not be + es.
  return out.sort((a, b) => b.length - a.length);
};

/**
 * Front-code an alphabetically sorted list.
 * @param {string[]} sorted - Sorted words
 * @returns {string} Encoded band
 * @example
 * frontCode(['help', 'hello']) // "0help,3lo"
 */
const frontCode = (sorted) => {
  let previous = '';
  return sorted.map((word) => {
    let shared = 0;
    const limit = Math.min(35, previous.length, word.length);
    while (shared < limit && previous[shared] === word[shared]) shared += 1;
    previous = word;
    return shared.toString(36) + word.slice(shared);
  }).join(',');
};

const { bands: frequency, lemmaBands: lowerBand } = parseFrequency(await lines('2+2+3frq.txt'));
/** @type {Map<string, number>} */
const all = new Map(frequency);
let inflected = 0;
let dropped = 0;
for (const raw of await lines('2of12inf.txt')) {
  if (!raw || raw.endsWith('%')) continue;
  const word = raw.replace(/[!%*+~^&=<>#$@]+$/, '');
  if (!WORD.test(word) || all.has(word)) continue;
  // Short lemmas (a, be, in, me) mostly give false matches (ares, bees, ins, meed), so skip them.
  const lemma = lemmas(word.toLowerCase()).find((l) => l.length >= 3 && lowerBand.has(l));
  if (!lemma) {
    dropped += 1;
    continue;
  }
  all.set(word, Math.min(22, lowerBand.get(lemma) + 1));
  inflected += 1;
}

const ranked = [...all].sort((a, b) => a[1] - b[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_WORDS);
const byBand = new Map();
for (const [word, band] of ranked) {
  if (!byBand.has(band)) byBand.set(band, []);
  byBand.get(band).push(word);
}
const maxBand = Math.max(...byBand.keys());
const encoded = Array.from({ length: maxBand }, (_, i) => frontCode((byBand.get(i + 1) ?? []).sort())).join('|');
if (/[`\\$]/.test(encoded)) throw new Error('unexpected character in encoded list');

// Full permission notices (verbatim from data/12dicts-6.0.2/agid.txt and THIRD_PARTY_LICENSES.md),
// so that this file and dist/bundle.js each satisfy the notice requirements on their own, without
// depending on THIRD_PARTY_LICENSES.md being kept alongside them. Every notice below is reproduced
// verbatim: do not shorten, paraphrase, or otherwise alter this text.
const NOTICE = `/*! English word list: ${ranked.length} words derived from 12dicts 6.0.2 (Alan Beale).
 * 12dicts is compiled by Alan Beale; the lists used here (2of12inf, 2+2+3frq) depend on AGID and
 * so are not public domain. Used here under the permission notices below, reproduced in full.
 *
 * AGID:
 *
 *   Copyright 2000 by Kevin Atkinson
 *
 *   Permission to use, copy, modify, distribute and sell this database,
 *   the associated scripts, the output created form the scripts and its
 *   documentation for any purpose is hereby granted without fee,
 *   provided that the above copyright notice appears in all copies and
 *   that both that copyright notice and this permission notice appear in
 *   supporting documentation. Kevin Atkinson makes no representations
 *   about the suitability of this array for any purpose. It is provided
 *   "as is" without express or implied warranty.
 *
 * WordNet 1.6 (used by AGID for part-of-speech data):
 *
 *   This software and database is being provided to you, the LICENSEE, by
 *   Princeton University under the following license.  By obtaining, using
 *   and/or copying this software and database, you agree that you have
 *   read, understood, and will comply with these terms and conditions.:
 *
 *   Permission to use, copy, modify and distribute this software and
 *   database and its documentation for any purpose and without fee or
 *   royalty is hereby granted, provided that you agree to comply with
 *   the following copyright notice and statements, including the disclaimer,
 *   and that the same appear on ALL copies of the software, database and
 *   documentation, including modifications that you make for internal
 *   use or for distribution.
 *
 *   WordNet 1.6 Copyright 1997 by Princeton University.  All rights reserved.
 *
 *   THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON
 *   UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
 *   IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PRINCETON
 *   UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF MERCHANT-
 *   ABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE
 *   OF THE LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT
 *   INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR
 *   OTHER RIGHTS.
 *
 *   The name of Princeton University or Princeton may not be used in
 *   advertising or publicity pertaining to distribution of the software
 *   and/or database.  Title to copyright in this software, database and
 *   any associated documentation shall at all times remain with
 *   Princeton University and LICENSEE agrees to preserve same.
 *
 * UK Advanced Cryptics Dictionary (one of AGID's word-list sources):
 *
 *   Copyright (c) J Ross Beresford 1993-1999. All Rights Reserved.
 *
 *   The following restriction is placed on the use of this
 *   publication: if The UK Advanced Cryptics Dictionary is used
 *   in a software package or redistributed in any form, the
 *   copyright notice must be prominently displayed and the text
 *   of this document must be included verbatim.
 *
 *   There are no other restrictions: I would like to see the
 *   list distributed as widely as possible.
 */`;
if (NOTICE.slice(2, -2).includes('*/')) throw new Error('notice text would terminate the comment early');

const source = `${NOTICE}
// Generated by scripts/build-words.js (${maxBand} frequency bands). Do not edit by hand.
export const WORDS_EN = \`${encoded}\`;
`;
await writeFile(OUT, source);
console.log(`lemmas+irregular: ${frequency.size}, regular inflections added: ${inflected}, dropped (no lemma): ${dropped}`);
console.log(`words: ${ranked.length}, bands: ${maxBand}, encoded: ${(encoded.length / 1024).toFixed(1)} KiB`);
