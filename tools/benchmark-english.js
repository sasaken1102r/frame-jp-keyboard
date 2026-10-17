// Compare correction latency against a saved original src/english.js module on the same host.
// Usage: node tools/benchmark-english.js /path/to/baseline-english.mjs
// No network, Steam connection, timing assertions or installed files are involved.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { WORDS_EN } from '../src/data/words-en.js';

if (!process.argv[2]) throw new Error('Pass the original src/english.js as the first argument');
const load = async (path, minify) => {
  const result = await build({
    stdin: { contents: await readFile(path, 'utf8'), sourcefile: 'english.js' },
    format: 'esm', target: 'chrome126', write: false, charset: 'utf8', minify,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};
const before = await load(process.argv[2], false);
const after = await load(new URL('../src/english.js', import.meta.url), true);
const dict = before.createDictionary(before.decodeWords(WORDS_EN));
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const cases = [
  { kind: 'completion', words: ['h', 'th', 'hel', 'key'], iterations: 600 },
  { kind: 'single-edit', words: ['helo', 'thnak', 'recieve', 'keyboadr'], iterations: 600 },
  { kind: 'second-edit', words: ['reciev', 'xylophne', 'qzxwv', 'zzzzzzzzzz'], iterations: 8 },
];
let sink = 0;
const rows = [];
for (const { kind, words, iterations } of cases) {
  const run = (impl, word) => kind === 'completion' ? impl.suggest(dict, word) : impl.correctionsFor(dict, word);
  for (const word of words) {
    assert.deepEqual(run(after, word), run(before, word), `candidate order for ${word}`);
    for (let i = 0; i < 16; i += 1) { sink += run(before, word).length; sink += run(after, word).length; }
    const samples = { before: [], after: [] };
    for (let round = 0; round < 9; round += 1) {
      const order = round % 2 ? [['after', after], ['before', before]] : [['before', before], ['after', after]];
      for (const [name, impl] of order) {
        const start = performance.now();
        for (let i = 0; i < iterations; i += 1) sink += run(impl, word).length;
        samples[name].push((performance.now() - start) * 1000 / iterations);
      }
    }
    const oldUs = median(samples.before);
    const newUs = median(samples.after);
    rows.push({ kind, word, beforeUs: oldUs, afterUs: newUs, ratio: newUs / oldUs, samples });
  }
}
console.log(JSON.stringify({
  node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0].model,
  note: 'Warm single-thread V8 timings; native CPU runner, not a Steam Frame or Steam Chromium.',
  rounds: 9, source: 'original readable vs optimized minified module, same dictionary and engine', rows, sink,
}, null, 2));
