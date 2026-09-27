import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIme } from '../src/ime.js';
import { createComposer } from '../src/composer.js';

/**
 * A mock of the libanthy backend. `dict` maps a reading to candidates (one segment) or to a list of
 * [segment reading, candidates] (several segments). Segments can be resized; commits are recorded
 * and learned (the chosen candidate comes first next time), like anthy.
 * @param {Record<string, string[]|[string, string[]][]>} [dict] - Conversions
 * @param {Record<string, string[]>} [predictions] - Predictions by reading
 * @returns {object} Backend with `calls`, `commits`, `delay` and `fail`
 * @example
 * mockBackend({ かんじ: ['漢字', '感じ'] })
 */
const mockBackend = (dict = {}, predictions = {}) => {
  const preferred = new Map();
  const backend = {
    calls: [],
    commits: [],
    delay: 0,
    fail: false,
  };
  /**
   * Wait like a slow backend, or fail.
   * @returns {Promise<void>} Resolves after the delay
   * @example
   * await pause()
   */
  const pause = async () => {
    if (backend.delay) await new Promise((r) => setTimeout(r, backend.delay));
    if (backend.fail) throw new Error('backend failed');
  };
  /**
   * Candidates for one segment reading (learned choice first, reading last).
   * @param {string} reading - Segment reading
   * @returns {string[]} Candidates
   * @example
   * candidatesFor('きかい')
   */
  const candidatesFor = (reading) => {
    const entry = dict[reading];
    const base = Array.isArray(entry) && typeof entry[0] === 'string' ? entry : [];
    const list = [...base.filter((c) => c !== reading), reading];
    const p = preferred.get(reading);
    return p && list.includes(p) ? [p, ...list.filter((c) => c !== p)] : list;
  };
  /**
   * Segments for a reading, from the dictionary or from explicit lengths.
   * @param {string} reading - Reading
   * @param {number[]} [lengths] - Segment lengths
   * @returns {{reading: string, candidates: string[]}[]} Segments
   * @example
   * segmentsFor('かんじ')
   */
  const segmentsFor = (reading, lengths) => {
    let parts;
    if (lengths?.length && lengths.reduce((a, b) => a + b, 0) === Array.from(reading).length) {
      const chars = Array.from(reading);
      let at = 0;
      parts = lengths.map((n) => {
        const part = chars.slice(at, at + n).join('');
        at += n;
        return part;
      });
    } else {
      const entry = dict[reading];
      parts = Array.isArray(entry) && Array.isArray(entry[0]) ? entry.map(([r]) => r) : [reading];
    }
    return parts.map((part) => {
      const multi = dict[reading];
      const fromMulti = Array.isArray(multi) && Array.isArray(multi[0]) ? multi.find(([r]) => r === part)?.[1] : null;
      const list = fromMulti ? [...fromMulti, part] : candidatesFor(part);
      const p = preferred.get(part);
      return { reading: part, candidates: p && list.includes(p) ? [p, ...list.filter((c) => c !== p)] : list };
    });
  };
  Object.assign(backend, {
    convert: async (reading, lengths) => {
      backend.calls.push(['convert', reading]);
      await pause();
      return segmentsFor(reading, lengths);
    },
    resize: async (reading, lengths, index, delta) => {
      backend.calls.push(['resize', reading, index, delta]);
      await pause();
      const next = [...lengths];
      if (index + 1 < next.length && next[index] + delta > 0 && next[index + 1] - delta >= 0) {
        next[index] += delta;
        next[index + 1] -= delta;
      }
      return segmentsFor(reading, next.filter((n) => n > 0));
    },
    predict: async (reading) => {
      backend.calls.push(['predict', reading]);
      await pause();
      return predictions[reading] ?? [];
    },
    commit: async (c) => {
      backend.commits.push(c);
      c.lengths.forEach((n, i) => preferred.set(Array.from(c.reading).slice(c.lengths.slice(0, i).reduce((a, b) => a + b, 0)).slice(0, n).join(''), c.texts[i]));
      return true;
    },
    commitPrediction: async (p) => {
      backend.commits.push({ prediction: p });
      return true;
    },
  });
  return backend;
};

/**
 * Build a controller with a mock backend, an output log and manual timers.
 * @param {object|null} engine - Backend or null
 * @param {object} [options] - Extra createIme options
 * @returns {{ime: object, out: object[], warnings: string[], fire: () => Promise<void>}} Harness
 * @example
 * setup(mockBackend())
 */
const setup = (engine, options = {}) => {
  const settings = { toggleInput: false, toggleTimeoutMs: 800 };
  const out = [];
  const warnings = [];
  const timers = new Map();
  let nextId = 1;
  const ime = createIme({
    engine,
    direct: createComposer(() => settings),
    compose: createComposer(() => settings),
    send: (ops) => out.push(...ops),
    warn: (...a) => warnings.push(a.join(' ')),
    setTimer: (fn) => {
      timers.set(nextId, fn);
      return nextId++;
    },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });
  return {
    ime,
    out,
    warnings,
    /**
     * Fire the pending debounce and wait for the live request.
     * @returns {Promise<void>} Resolves when idle
     * @example
     * await fire()
     */
    fire: async () => {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
      await ime.flush();
    },
  };
};

const SENTENCE = { きょうはいいてんき: [['きょうは', ['今日は', '京は']], ['いいてんき', ['いい天気']]] };

test('edits show in the reading at once; nothing reaches the target', () => {
  const { ime, out } = setup(mockBackend());
  ime.kana('ha', 'center');
  assert.equal(ime.view().preedit, 'は');
  ime.kana('sa', 'left');
  ime.modify();
  assert.equal(ime.view().preedit, 'はじ');
  ime.backspace();
  assert.equal(ime.view().preedit, 'は');
  ime.undo();
  assert.equal(ime.view().preedit, 'はじ');
  ime.arrow('left');
  ime.kana('a', 'center');
  assert.equal(ime.view().preedit, 'はあじ');
  assert.deepEqual(out, []);
});

test('live candidates: whole sentence, first segment, predictions, hiragana, katakana', async () => {
  const backend = mockBackend(SENTENCE, { きょうはいいてんき: ['今日はいい天気です'] });
  const { ime, fire, out } = setup(backend);
  ime.kanaText('きょうはいいてんき');
  assert.deepEqual(ime.view().candidates, []);
  await fire();
  assert.deepEqual(ime.view().candidates, ['今日はいい天気', '今日は', '京は', 'きょうは', '今日はいい天気です', 'きょうはいいてんき', 'キョウハイイテンキ']);
  assert.deepEqual(out, []);
  assert.equal(backend.commits.length, 0); // previews never learn
});

test('typing after candidates marks them stale until fresh ones arrive', async () => {
  const { ime, fire } = setup(mockBackend({ かん: ['缶'], かんじ: ['漢字'] }));
  ime.kanaText('かん');
  await fire();
  ime.kanaText('じ');
  assert.equal(ime.view().stale, true);
  await fire();
  assert.equal(ime.view().stale, false);
  assert.equal(ime.view().candidates[0], '漢字');
});

test('a reply for an older reading is dropped', async () => {
  const backend = mockBackend({ かん: ['缶'], かんじ: ['漢字'] });
  backend.delay = 20;
  const { ime, fire } = setup(backend);
  ime.kanaText('かん');
  const firing = fire(); // request for かん in flight
  ime.kanaText('じ');
  await firing;
  assert.notEqual(ime.view().candidates[0], '缶');
  assert.equal(ime.liveInfo().stale, 1);
});

test('変換 → 次候補 → ⏎ commits and teaches anthy the choice', async () => {
  const backend = mockBackend({ きかい: ['機械', '器械', '奇怪'] });
  const { ime, out } = setup(backend);
  ime.kanaText('きかい');
  await ime.space();
  assert.equal(ime.view().phase, 'converting');
  assert.deepEqual(ime.view().candidates, ['機械', '器械', '奇怪', 'きかい']);
  await ime.space();
  assert.equal(ime.view().selected, 1);
  await ime.enter();
  assert.deepEqual(out, [{ text: '器械' }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(backend.commits, [{ reading: 'きかい', lengths: [3], choices: [1], texts: ['器械'] }]);
  // Learned: next time it comes first.
  ime.kanaText('きかい');
  await ime.space();
  assert.equal(ime.view().candidates[0], '器械');
});

test('変換 reuses the live result for the same reading (no extra request)', async () => {
  const backend = mockBackend({ かんじ: ['漢字'] });
  const { ime, fire } = setup(backend);
  ime.kanaText('かんじ');
  await fire();
  const before = backend.calls.filter(([op]) => op === 'convert').length;
  await ime.space();
  assert.equal(backend.calls.filter(([op]) => op === 'convert').length, before);
  assert.equal(ime.view().preedit, '漢字');
});

test('tapping a non-last segment moves on; tapping the last one commits all with learning', async () => {
  const backend = mockBackend(SENTENCE);
  const { ime, out } = setup(backend);
  ime.kanaText('きょうはいいてんき');
  await ime.space();
  await ime.select(1, '京は');
  let v = ime.view();
  assert.equal(v.phase, 'converting');
  assert.equal(v.preedit, '京はいい天気');
  assert.deepEqual(v.candidates, ['いい天気', 'いいてんき']);
  assert.equal(v.segStart, 2);
  assert.deepEqual(out, []);
  await ime.select(0, 'いい天気');
  assert.deepEqual(out, [{ text: '京はいい天気' }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(backend.commits[0].texts, ['京は', 'いい天気']);
  assert.deepEqual(backend.commits[0].choices, [1, 0]);
  v = ime.view();
  assert.equal(v.phase, 'idle');
});

test('live taps: the whole sentence commits with learning; a segment candidate starts the conversion', async () => {
  const backend = mockBackend(SENTENCE);
  const { ime, fire, out } = setup(backend);
  ime.kanaText('きょうはいいてんき');
  await fire();
  await ime.select(0, '今日はいい天気');
  assert.deepEqual(out, [{ text: '今日はいい天気' }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(backend.commits[0].choices, [0, 0]);
  ime.kanaText('きょうはいいてんき');
  await fire();
  await ime.select(ime.view().candidates.indexOf('京は'), '京は');
  assert.equal(ime.view().phase, 'converting');
  assert.equal(ime.view().preedit, '京はいい天気');
  await ime.enter();
  assert.deepEqual(out.at(-1), { text: '京はいい天気' });
});

test('live taps: a prediction is learned; hiragana and katakana are committed without learning', async () => {
  const backend = mockBackend({}, { てん: ['天気です', '天才'] });
  const { ime, fire, out } = setup(backend);
  ime.kanaText('てん');
  await fire();
  assert.deepEqual(ime.view().candidates, ['てん', '天気です', '天才', 'テン']);
  await ime.select(2, '天才');
  assert.deepEqual(out, [{ text: '天才' }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(backend.commits, [{ prediction: { reading: 'てん', index: 1, text: '天才' } }]);
  ime.kanaText('てん');
  await fire();
  await ime.select(3, 'テン');
  ime.kanaText('てん');
  await fire();
  await ime.select(0, 'てん');
  assert.deepEqual(out.slice(1), [{ text: 'テン' }, { text: 'てん' }]);
  await new Promise((r) => setTimeout(r, 0));
  // Katakana is not learned; "てん" here is anthy's own whole-sentence result, so it is (like ⏎).
  assert.equal(backend.commits.length, 2);
  assert.deepEqual(backend.commits[1].texts, ['てん']);
});

test('a tap on a stale list refreshes and picks the same text, or does nothing', async () => {
  const backend = mockBackend({ かん: ['缶', '感'], かんじ: ['漢字', '感じ'] });
  const { ime, fire, out } = setup(backend);
  ime.kanaText('かんじ');
  await fire();
  ime.backspace(); // list still for かんじ
  await ime.select(0, '漢字');
  assert.deepEqual(out, []);
  await ime.select(1, '感');
  assert.deepEqual(out, [{ text: '感' }]);
});

test('← → while converting resize the current segment; earlier choices are kept', async () => {
  const backend = mockBackend({ あいう: [['あ', ['亜']], ['いう', ['言う']]], あい: ['愛'], う: ['鵜'] });
  const { ime } = setup(backend);
  ime.kanaText('あいう');
  await ime.space();
  assert.deepEqual(ime.view().preedit, '亜言う');
  await ime.arrow('right');
  const v = ime.view();
  assert.equal(v.candidates[0], '愛');
  assert.equal(v.preedit, '愛鵜');
  assert.ok(backend.calls.some(([op, , i, d]) => op === 'resize' && i === 0 && d === 1));
});

test('⌫, ↶ and ゛゜小 while converting go back to the reading', async () => {
  const { ime } = setup(mockBackend({ はし: ['橋'] }));
  ime.kanaText('はし');
  await ime.space();
  await ime.backspace();
  assert.equal(ime.view().phase, 'composing');
  assert.equal(ime.view().preedit, 'はし');
  await ime.space();
  await ime.undo();
  assert.equal(ime.view().preedit, 'はし');
  await ime.space();
  await ime.modify();
  assert.equal(ime.view().preedit, 'はじ');
});

test('typing while converting commits the conversion first', async () => {
  const { ime, out } = setup(mockBackend({ き: ['木'] }));
  ime.kanaText('き');
  await ime.space();
  await ime.kana('a', 'center');
  assert.deepEqual(out, [{ text: '木' }]);
  assert.equal(ime.view().preedit, 'あ');
});

test('keys pressed while a slow conversion is pending queue behind it', async () => {
  const backend = mockBackend({ き: ['木'] });
  backend.delay = 20;
  const { ime, out } = setup(backend);
  ime.kanaText('き');
  const pending = [ime.space(), ime.kana('a', 'center'), ime.enter()];
  await Promise.all(pending);
  assert.deepEqual(out, [{ text: '木' }, { text: 'あ' }]);
});

test('⏎ commits the reading as typed; idle keys go to the target', async () => {
  const { ime, out } = setup(mockBackend());
  ime.kanaText('てすと');
  await ime.enter();
  await ime.enter();
  await ime.space();
  await ime.backspace();
  await ime.arrow('left');
  assert.deepEqual(out, [{ text: 'てすと' }, { key: 'Enter' }, { text: ' ' }, { key: 'Backspace' }, { key: 'ArrowLeft' }]);
});

test('literal text and commitAll commit the reading first', async () => {
  const { ime, out } = setup(mockBackend());
  ime.kanaText('ね');
  await ime.text('！');
  ime.kanaText('あ');
  await ime.commitAll();
  assert.deepEqual(out, [{ text: 'ね' }, { text: '！' }, { text: 'あ' }]);
});

test('release throws the composition away', async () => {
  const { ime, out } = setup(mockBackend());
  ime.kanaText('ひみつ');
  await ime.release();
  assert.deepEqual(out, []);
  assert.equal(ime.view().phase, 'idle');
});

test('without a backend kana are typed directly (fallback)', async () => {
  const { ime, out } = setup(null);
  await ime.kana('a', 'center');
  await ime.modify();
  await ime.space();
  assert.deepEqual(out, [{ text: 'あ' }, { key: 'Backspace' }, { text: 'ぁ' }, { text: ' ' }]);
  assert.equal(ime.view().phase, 'direct');
});

test('a backend that becomes available later is attached', async () => {
  const backend = mockBackend({ かんじ: ['漢字'] });
  const { ime } = setup(null);
  ime.attachEngine(backend);
  await ime.flush();
  ime.kanaText('かんじ');
  await ime.space();
  assert.equal(ime.view().preedit, '漢字');
});

test('a failing backend is reported and the reading stays', async () => {
  const backend = mockBackend({ かんじ: ['漢字'] });
  const { ime, fire, warnings, out } = setup(backend);
  ime.kanaText('かんじ');
  backend.fail = true;
  await fire();
  await ime.space();
  assert.equal(ime.view().phase, 'composing');
  assert.equal(ime.view().preedit, 'かんじ');
  assert.ok(warnings.length >= 2);
  backend.fail = false;
  await ime.enter();
  assert.deepEqual(out, [{ text: 'かんじ' }]);
});

test('an invalid candidate index changes nothing', async () => {
  const { ime, fire, out } = setup(mockBackend({ かんじ: ['漢字'] }));
  ime.kanaText('かんじ');
  await fire();
  await ime.select(-1);
  await ime.select(99);
  assert.deepEqual(out, []);
  assert.equal(ime.view().preedit, 'かんじ');
});
