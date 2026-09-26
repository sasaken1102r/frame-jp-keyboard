import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIme } from '../src/ime.js';
import { createComposer } from '../src/composer.js';
import { kanaToRomaji, KEYSYM, SHIFT_MASK } from '../src/romaji.js';

// Inverse romaji table for the fake engine, built from the real table.
const KANA = Array.from('あいうえおかきくけこがぎぐげごさしすせそざじずぜぞたちつてとだぢづでどなにぬねのはひふへほばびぶべぼぱぴぷぺぽまみむめもやゆよらりるれろわをんぁぃぅぇぉゃゅょゎっー、。？！「」');
const FROM_ROMAJI = new Map(KANA.map((ch) => [kanaToRomaji(ch), ch]));
const KEY_NAMES = {
  [KEYSYM.BackSpace]: 'BS',
  [KEYSYM.Tab]: 'TAB',
  [KEYSYM.Return]: 'RET',
  [KEYSYM.Escape]: 'ESC',
  [KEYSYM.Left]: 'L',
  [KEYSYM.Right]: 'R',
  [KEYSYM.Up]: 'UP',
  [KEYSYM.Down]: 'DOWN',
  [KEYSYM.Page_Down]: 'PGDN',
  [KEYSYM.Page_Up]: 'PGUP',
  [KEYSYM.space]: 'SPC',
};

/**
 * A small stand-in for ibus-anthy. It decodes our romaji strokes, converts readings from a
 * dictionary, keeps anthy's modes (input / conversion / prediction), emits a lookup-table update for
 * every handled key like the real engine, and commits through the controller.
 * @param {Record<string, string[]|[string, string[]][]>} dict - Reading -> candidates of a single
 *   segment, or a list of [segment reading, candidates] for a multi-segment conversion
 * @param {Record<string, string[]>} [predictions] - Reading -> predictions
 * @returns {object} Fake engine with `strokes`, `calls` and `learned` logs. Like anthy, only Return
 *   learns (commit_segment / commit_prediction): a learned candidate comes first next time.
 * @example
 * fakeEngine({ かんじ: ['漢字', '感じ'] })
 */
const fakeEngine = (dict = {}, predictions = {}) => {
  const state = { preedit: '', cursor: 0, candidates: [], candidateCursor: 0, pageSize: 5, lutVisible: false, lutSignals: 0, lutApplied: 0 };
  let reading = [];
  let caret = 0;
  let pending = '';
  /** @type {'input'|'conv'|'pred'} */
  let mode = 'input';
  /** @type {{reading: string, cands: string[], sel: number}[]} */
  let segs = [];
  /** Current segment (anthy's __cursor_pos). */
  let cur = 0;
  /** Learned choices: reading -> candidate that comes first next time. */
  const preferred = new Map();
  const engine = {
    state,
    strokes: [],
    calls: [],
    learned: [],
    onCommit: () => {},
    fail: false,
    acquire: async () => { engine.calls.push('acquire'); },
    settle: async () => {},
    waitFor: async (predicate) => predicate(state),
    reset: async () => { engine.calls.push('reset'); clear(); },
    release: async () => { engine.calls.push('release'); clear(); },
    press: async (strokes) => {
      if (engine.fail) throw new Error('boom');
      return strokes.map((s) => handle(s));
    },
  };
  /**
   * Emit a lookup-table update.
   * @param {string[]} candidates - Table
   * @param {boolean} visible - Visibility
   * @returns {void}
   * @example
   * lut([], false)
   */
  const lut = (candidates, visible) => {
    state.lutSignals += 1;
    Object.assign(state, { candidates, lutVisible: visible && candidates.length > 0, lutApplied: state.lutSignals });
  };
  /**
   * Show the input-mode preedit.
   * @returns {void}
   * @example
   * showInput()
   */
  const showInput = () => {
    mode = 'input';
    Object.assign(state, { preedit: reading.join(''), cursor: caret, candidateCursor: 0 });
    lut([], false);
  };
  /**
   * Show the conversion: every segment's selected candidate; the table and cursor of the current one.
   * @returns {void}
   * @example
   * showConv()
   */
  const showConv = () => {
    state.preedit = segs.map((s) => s.cands[s.sel]).join('');
    state.cursor = segs.slice(0, cur).map((s) => s.cands[s.sel]).join('').length;
    state.candidateCursor = segs[cur].sel;
    lut(segs[cur].cands, true);
  };
  /**
   * Put a learned candidate first.
   * @param {string} readingText - Reading
   * @param {string[]} cands - Candidates
   * @returns {string[]} Reordered candidates
   * @example
   * withLearned('きかい', ['機械', '器械'])
   */
  const withLearned = (readingText, cands) => {
    const p = preferred.get(readingText);
    return p && cands.includes(p) ? [p, ...cands.filter((c) => c !== p)] : cands;
  };
  /**
   * Drop the composition and go back to input mode.
   * @returns {void}
   * @example
   * clear()
   */
  const clear = () => {
    reading = [];
    caret = 0;
    pending = '';
    segs = [];
    showInput();
  };
  /**
   * Commit text like anthy's commit-text signal.
   * @param {string} text - Committed text
   * @returns {void}
   * @example
   * commit('漢字')
   */
  const commit = (text) => {
    clear();
    engine.onCommit(text);
  };
  /**
   * Handle one stroke.
   * @param {{keyval: number, state: number}} s - Stroke
   * @returns {boolean} Handled
   * @example
   * handle({ keyval: 0x61, state: 0 })
   */
  const handle = ({ keyval, state: mods }) => {
    const name = KEY_NAMES[keyval] ?? String.fromCharCode(keyval);
    engine.strokes.push(mods & SHIFT_MASK ? `S-${name}` : name);
    if (/^[0-9]$/.test(name)) throw new Error('digit keys commit without learning; must not be used');
    if (mode === 'conv' || mode === 'pred') {
      const seg = mode === 'conv' ? segs[cur] : null;
      const size = mode === 'conv' ? seg.cands.length : state.candidates.length;
      let sel = mode === 'conv' ? seg.sel : state.candidateCursor;
      if (name === 'ESC') { showInput(); return true; }
      if (name === 'RET') {
        if (mode === 'conv') {
          for (const sg of segs) {
            engine.learned.push(sg.cands[sg.sel]);
            preferred.set(sg.reading, sg.cands[sg.sel]);
          }
        } else {
          engine.learned.push(state.preedit);
        }
        commit(state.preedit);
        return true;
      }
      if (mode === 'conv' && name === 'R') {
        if (cur + 1 >= segs.length) return true; // last segment: nothing happens, no signal
        cur += 1;
        showConv();
        return true;
      }
      if (name === 'SPC' || name === 'DOWN') sel = Math.min(sel + 1, size - 1);
      else if (name === 'UP') sel = Math.max(sel - 1, 0);
      else if (name === 'PGDN' && sel + state.pageSize < size) sel += state.pageSize;
      else if (name === 'PGUP' && sel - state.pageSize >= 0) sel -= state.pageSize;
      else return true;
      if (mode === 'conv') {
        seg.sel = sel;
        showConv();
      } else {
        state.candidateCursor = sel;
        state.preedit = state.candidates[sel];
        lut(state.candidates, true);
      }
      return true;
    }
    if (name === 'SPC') {
      if (!reading.length) return false;
      const text = reading.join('');
      const entry = dict[text] ?? [text];
      segs = typeof entry[0] === 'string'
        ? [{ reading: text, cands: withLearned(text, [...entry.filter((c) => c !== text), text]), sel: 0 }]
        : entry.map(([r, cands]) => ({ reading: r, cands: withLearned(r, [...cands, r]), sel: 0 }));
      cur = 0;
      mode = 'conv';
      showConv();
      return true;
    }
    if (name === 'TAB') {
      const preds = predictions[reading.join('')];
      if (!preds?.length) return true; // anthy: handled, but no signal at all
      mode = 'pred';
      state.preedit = preds[0];
      state.candidateCursor = 0;
      lut([...preds], true);
      return true;
    }
    if (name === 'RET') { commit(reading.join('')); return true; }
    if (name === 'ESC') { clear(); return true; }
    if (name === 'BS') { if (caret > 0) { reading.splice(caret - 1, 1); caret -= 1; } }
    else if (name === 'L') caret = Math.max(0, caret - 1);
    else if (name === 'R') caret = Math.min(reading.length, caret + 1);
    else {
      pending += name;
      const kana = FROM_ROMAJI.get(pending);
      const longer = [...FROM_ROMAJI.keys()].some((k) => k !== pending && k.startsWith(pending));
      if (kana && !longer) {
        reading.splice(caret, 0, kana);
        caret += 1;
        pending = '';
      }
    }
    showInput();
    return true;
  };
  return engine;
};

/**
 * Build a controller wired to a fake engine, an output log and manual timers.
 * @param {object|null} engine - Fake engine or null
 * @param {object} [options] - Extra createIme options
 * @returns {{ime: ReturnType<typeof createIme>, out: object[], warnings: string[], fire: () => Promise<void>, timers: number}} Test harness
 * @example
 * setup(fakeEngine())
 */
const setup = (engine, options = {}) => {
  const settings = { toggleInput: false, toggleTimeoutMs: 800 };
  const out = [];
  const warnings = [];
  /** @type {Map<number, () => void>} */
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
  if (engine) engine.onCommit = (text) => ime.handleCommit(text);
  return {
    ime,
    out,
    warnings,
    /**
     * Fire every pending timer (the debounce) and wait for the queue.
     * @returns {Promise<void>} Resolves when the queue is empty
     * @example
     * await fire()
     */
    fire: async () => {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
      await ime.flush();
    },
    get timers() {
      return timers.size;
    },
  };
};

test('かんじ -> 変換 -> 確定 commits 漢字, and nothing leaks before', async () => {
  const engine = fakeEngine({ かんじ: ['漢字', '感じ'] });
  const { ime, out } = setup(engine);
  await ime.kana('ka', 'center');
  await ime.kana('wa', 'up'); // ん
  await ime.kana('sa', 'left'); // し
  await ime.modify(); // じ
  assert.deepEqual(ime.view().preedit, 'かんじ');
  assert.equal(ime.view().phase, 'composing');
  assert.equal(engine.strokes.join(' '), 'k a n n s i BS z i');
  await ime.space();
  assert.equal(ime.view().phase, 'converting');
  assert.deepEqual(ime.view().candidates, ['漢字', '感じ', 'かんじ']);
  assert.equal(ime.view().segLength, 2);
  assert.deepEqual(out, []);
  await ime.space(); // 次候補
  assert.equal(ime.view().selected, 1);
  await ime.enter();
  assert.deepEqual(out, [{ text: '感じ' }]);
  assert.equal(ime.view().phase, 'idle');
  assert.equal(engine.calls[0], 'acquire');
});

test('Enter, space, Backspace go to the target when nothing is composed', async () => {
  const { ime, out } = setup(fakeEngine());
  await ime.enter();
  await ime.space();
  await ime.backspace();
  await ime.arrow('left');
  assert.deepEqual(out, [{ key: 'Enter' }, { text: ' ' }, { key: 'Backspace' }, { key: 'ArrowLeft' }]);
});

test('⌫ edits the preedit, and cancels a conversion back to the reading', async () => {
  const engine = fakeEngine({ かな: ['仮名'] });
  const { ime, out } = setup(engine);
  await ime.kanaText('かなあ');
  await ime.backspace();
  assert.equal(ime.view().preedit, 'かな');
  await ime.space();
  assert.equal(ime.view().preedit, '仮名');
  await ime.backspace();
  assert.equal(ime.view().phase, 'composing');
  assert.equal(ime.view().preedit, 'かな');
  await ime.modify(); // な has no variant; は would. Nothing happens.
  await ime.backspace();
  await ime.backspace();
  assert.equal(ime.view().phase, 'idle');
  assert.deepEqual(out, []);
});

test('↶ undoes the last kana; ゛゜小 after cancelling a conversion edits the reading', async () => {
  const engine = fakeEngine({ はし: ['橋', '箸'] });
  const { ime, out } = setup(engine);
  await ime.kana('ha', 'center');
  await ime.kana('sa', 'left');
  await ime.kana('a', 'center');
  await ime.undo();
  assert.equal(ime.view().preedit, 'はし');
  await ime.space();
  await ime.modify(); // cancel conversion, し -> じ
  assert.equal(ime.view().preedit, 'はじ');
  await ime.enter();
  assert.deepEqual(out, [{ text: 'はじ' }]);
  // Idle: ↶ undoes the committed text in the target.
  await ime.undo();
  assert.deepEqual(out.slice(1), [{ key: 'Backspace' }, { key: 'Backspace' }]);
});

test('typing while converting commits the conversion first', async () => {
  const engine = fakeEngine({ き: ['木'] });
  const { ime, out } = setup(engine);
  await ime.kana('ka', 'left');
  await ime.space();
  await ime.kana('a', 'center');
  assert.deepEqual(out, [{ text: '木' }]);
  assert.equal(ime.view().preedit, 'あ');
});

test('tapping a candidate moves the cursor with Page_Down/Down (never digits), then Return learns it', async () => {
  const engine = fakeEngine({ かんじ: ['漢字', '監事', '莞爾', '幹事', '感じ', '巻次'] });
  const { ime, out } = setup(engine);
  await ime.kanaText('かんじ');
  await ime.space();
  engine.strokes.length = 0;
  await ime.select(6, 'かんじ'); // the 7th candidate
  assert.deepEqual(engine.strokes, ['PGDN', 'DOWN', 'RET']);
  assert.deepEqual(out, [{ text: 'かんじ' }]);
  assert.deepEqual(engine.learned, ['かんじ']);
  assert.equal(ime.view().phase, 'idle');
});

test('a picked candidate comes first in the next conversion (きかい: 器械, then 機械 again)', async () => {
  const engine = fakeEngine({ きかい: ['機械', '器械', '奇怪'] });
  const { ime, out } = setup(engine);
  await ime.kanaText('きかい');
  await ime.space();
  await ime.select(1, '器械');
  await ime.kanaText('きかい');
  await ime.space();
  assert.equal(ime.view().candidates[0], '器械');
  await ime.select(1, '機械');
  await ime.kanaText('きかい');
  await ime.space();
  assert.equal(ime.view().candidates[0], '機械');
  assert.deepEqual(out, [{ text: '器械' }, { text: '機械' }]);
});

test('a candidate that moved in the table is found by its text; a vanished one commits nothing', async () => {
  const engine = fakeEngine({ かんじ: ['漢字', '感じ'] });
  const { ime, out } = setup(engine);
  await ime.kanaText('かんじ');
  await ime.space();
  await ime.select(0, '感じ'); // index is stale, text wins
  assert.deepEqual(out, [{ text: '感じ' }]);
  await ime.kanaText('かんじ');
  await ime.space();
  await ime.select(0, '存在しない');
  assert.equal(ime.view().phase, 'converting');
  assert.equal(out.length, 1);
});

test('tapping a candidate of a non-last segment moves on to the next segment; ⏎ commits all with learning', async () => {
  const engine = fakeEngine(SENTENCE);
  const { ime, out } = setup(engine);
  await ime.kanaText('きょうはいいてんき');
  await ime.space();
  engine.strokes.length = 0;
  await ime.select(1, '京は');
  assert.deepEqual(engine.strokes, ['DOWN', 'R']);
  const v = ime.view();
  assert.equal(v.phase, 'converting');
  assert.equal(v.preedit, '京はいい天気');
  assert.deepEqual(v.candidates, ['いい天気', 'いいてんき']);
  assert.deepEqual(out, []);
  await ime.enter();
  assert.deepEqual(out, [{ text: '京はいい天気' }]);
  assert.deepEqual(engine.learned, ['京は', 'いい天気']);
});

test('tapping a candidate of the last segment commits everything', async () => {
  const engine = fakeEngine(SENTENCE);
  const { ime, out } = setup(engine);
  await ime.kanaText('きょうはいいてんき');
  await ime.space();
  await ime.select(0, '今日は');
  await ime.select(1, 'いいてんき');
  assert.deepEqual(out, [{ text: '今日はいいてんき' }]);
  assert.deepEqual(engine.learned, ['今日は', 'いいてんき']);
  assert.equal(ime.view().phase, 'idle');
});

test('arrows move the caret while composing and resize segments while converting', async () => {
  const engine = fakeEngine({ あい: ['愛'] });
  const { ime } = setup(engine);
  await ime.kanaText('あい');
  await ime.arrow('left');
  assert.equal(ime.view().caret, 1);
  await ime.kana('ka', 'center');
  assert.equal(ime.view().preedit, 'あかい');
  await ime.arrow('right');
  await ime.backspace();
  assert.equal(ime.view().preedit, 'あか');
  await ime.space();
  engine.strokes.length = 0;
  await ime.arrow('left');
  assert.deepEqual(engine.strokes, ['S-L']);
});

test('text and commitAll commit the composition before literal input', async () => {
  const { ime, out } = setup(fakeEngine());
  await ime.kanaText('ね');
  await ime.text('！');
  assert.deepEqual(out, [{ text: 'ね' }, { text: '！' }]);
  await ime.kanaText('あ');
  await ime.commitAll();
  assert.deepEqual(out.at(-1), { text: 'あ' });
});

test('release discards the composition without sending anything', async () => {
  const engine = fakeEngine();
  const { ime, out } = setup(engine);
  await ime.kanaText('ひみつ');
  await ime.release();
  assert.deepEqual(out, []);
  assert.equal(ime.view().phase, 'idle');
  assert.ok(engine.calls.includes('release'));
});

test('without an engine, kana are committed directly (fallback)', async () => {
  const { ime, out } = setup(null);
  await ime.kana('a', 'center');
  await ime.modify();
  await ime.space();
  assert.deepEqual(out, [{ text: 'あ' }, { key: 'Backspace' }, { text: 'ぁ' }, { text: ' ' }]);
  assert.equal(ime.view().phase, 'direct');
});

test('an engine failure falls back to direct input and keeps the shown text', async () => {
  const engine = fakeEngine();
  const { ime, out, warnings } = setup(engine);
  await ime.kanaText('あい');
  engine.fail = true;
  await ime.kana('a', 'left');
  assert.equal(ime.view().phase, 'direct');
  assert.deepEqual(out, [{ text: 'あいい' }]);
  assert.ok(warnings.some((w) => w.includes('conversion disabled')));
  await ime.kana('ka', 'center');
  assert.deepEqual(out.at(-1), { text: 'か' });
});

test('attachEngine switches from direct input to conversion', async () => {
  const engine = fakeEngine();
  const { ime } = setup(null);
  engine.onCommit = (t) => ime.handleCommit(t);
  ime.attachEngine(engine);
  await ime.kana('a', 'center');
  assert.equal(ime.view().phase, 'composing');
});

// ---- Live candidates while typing ----

const SENTENCE = {
  きょうはいいてんき: [['きょうは', ['今日は', '京は', 'キョウハ']], ['いいてんき', ['いい天気']]],
};

test('live candidates appear after the debounce, in the expected order, reading kept as preedit', async () => {
  const engine = fakeEngine(SENTENCE, { きょうはいいてんき: ['今日はいい天気です'] });
  const { ime, fire, out } = setup(engine);
  for (const ch of 'きょうはいいてんき') await ime.kanaText(ch);
  assert.deepEqual(ime.view().candidates, []); // nothing until the reading is quiet
  await fire();
  const v = ime.view();
  assert.equal(v.phase, 'composing');
  assert.equal(v.preedit, 'きょうはいいてんき');
  assert.equal(v.source, 'live');
  assert.deepEqual(v.candidates, ['今日はいい天気', '今日は', '京は', 'キョウハ', 'きょうは', '今日はいい天気です', 'きょうはいいてんき', 'キョウハイイテンキ']);
  assert.deepEqual(out, []);
  // anthy was peeked and put back exactly.
  assert.equal(engine.state.preedit, 'きょうはいいてんき');
  assert.ok(engine.strokes.join(' ').endsWith('SPC ESC TAB ESC'));
});

test('the debounce restarts on every key, so only one query runs', async () => {
  const engine = fakeEngine({ かんじ: ['漢字'] });
  const { ime, fire } = setup(engine);
  await ime.kanaText('か');
  await ime.kanaText('ん');
  await ime.kanaText('じ');
  await fire();
  assert.equal(engine.strokes.filter((s) => s === 'SPC').length, 1);
  assert.equal(ime.liveInfo().reading, 'かんじ');
});

test('a key pressed while a query is waiting cancels it; typing is never dropped', async () => {
  const engine = fakeEngine({ かんじ: ['漢字'], かんじん: ['肝心'] });
  const { ime, fire } = setup(engine);
  await ime.kanaText('かんじ');
  // Fire the debounce but press a key before the queued query gets to run.
  const pendingFire = fire();
  const key = ime.kanaText('ん');
  await pendingFire;
  await key;
  assert.equal(ime.liveInfo().aborted, 1);
  assert.equal(engine.strokes.includes('SPC'), false);
  assert.equal(ime.view().preedit, 'かんじん');
  await fire();
  assert.equal(ime.view().candidates[0], '肝心');
});

test('⌫, ゛゜小 and ↶ refresh the candidates too', async () => {
  const engine = fakeEngine({ はし: ['橋', '箸'], はじ: ['恥'], は: ['葉'] });
  const { ime, fire } = setup(engine);
  await ime.kana('ha', 'center');
  await ime.kana('sa', 'left');
  await fire();
  assert.equal(ime.view().candidates[0], '橋');
  await ime.modify();
  await fire();
  assert.equal(ime.view().candidates[0], '恥');
  await ime.backspace();
  await fire();
  assert.equal(ime.view().candidates[0], '葉');
  await ime.undo();
  await fire();
  assert.equal(ime.view().candidates[0], '恥');
});

test('tapping the first live candidate commits the whole sentence', async () => {
  const engine = fakeEngine(SENTENCE);
  const { ime, fire, out } = setup(engine);
  await ime.kanaText('きょうはいいてんき');
  await fire();
  await ime.select(0);
  assert.deepEqual(out, [{ text: '今日はいい天気' }]);
  assert.equal(ime.view().phase, 'idle');
});

test('a first-segment live candidate converts, picks it on segment 0 and moves to the next segment', async () => {
  const engine = fakeEngine(SENTENCE);
  const { ime, fire, out } = setup(engine);
  await ime.kanaText('きょうはいいてんき');
  await fire();
  await ime.select(ime.view().candidates.indexOf('京は'), '京は');
  assert.deepEqual(out, []);
  assert.equal(ime.view().phase, 'converting');
  assert.equal(ime.view().preedit, '京はいい天気');
  await ime.enter();
  assert.deepEqual(out, [{ text: '京はいい天気' }]);
  assert.deepEqual(engine.learned, ['京は', 'いい天気']);
});

test('the whole-sentence live candidate commits with Return, so anthy learns it', async () => {
  const engine = fakeEngine(SENTENCE);
  const { ime, fire, out } = setup(engine);
  await ime.kanaText('きょうはいいてんき');
  await fire();
  await ime.select(0, '今日はいい天気');
  assert.deepEqual(out, [{ text: '今日はいい天気' }]);
  assert.deepEqual(engine.learned, ['今日は', 'いい天気']);
});

test('live previews never send Return and never learn, however often the reading is typed', async () => {
  const engine = fakeEngine({ きかい: ['機械', '器械'] }, { きかい: ['機械的'] });
  const { ime, fire } = setup(engine);
  for (let i = 0; i < 3; i += 1) {
    await ime.kanaText('きかい');
    await fire();
    assert.equal(ime.view().candidates[0], '機械');
    await ime.release();
  }
  assert.equal(engine.strokes.includes('RET'), false);
  assert.deepEqual(engine.learned, []);
});

test('predictions commit through anthy (Tab, cursor, Return); hiragana and katakana commit the reading', async () => {
  const engine = fakeEngine({}, { てん: ['天気です', '天才'] });
  const { ime, fire, out } = setup(engine);
  await ime.kanaText('てん');
  await fire();
  assert.deepEqual(ime.view().candidates, ['てん', '天気です', '天才', 'テン']);
  engine.strokes.length = 0;
  await ime.select(2, '天才');
  assert.deepEqual(engine.strokes, ['TAB', 'DOWN', 'RET']);
  assert.deepEqual(out, [{ text: '天才' }]);
  assert.deepEqual(engine.learned, ['天才']);
  await ime.kanaText('てん');
  await fire();
  await ime.select(3, 'テン');
  assert.deepEqual(out.at(-1), { text: 'テン' });
  assert.equal(ime.view().phase, 'idle');
});

test('no prediction (no signal after Tab) leaves the reading untouched', async () => {
  const engine = fakeEngine({ みず: ['水'] });
  const { ime, fire } = setup(engine);
  await ime.kanaText('みず');
  await fire();
  assert.deepEqual(ime.view().candidates, ['水', 'みず', 'ミズ']);
  assert.equal(engine.state.preedit, 'みず');
  assert.equal(ime.liveInfo().resyncs, 0);
  await ime.kanaText('ぎ');
  assert.equal(engine.state.preedit, 'みずぎ');
});

test('a tap on a stale list refreshes first and picks the same text', async () => {
  const engine = fakeEngine({ かん: ['缶', '感'], かんじ: ['漢字', '感じ'] });
  const { ime, fire, out } = setup(engine);
  await ime.kanaText('かんじ');
  await fire();
  await ime.backspace(); // list still shows かんじ's candidates until the next query
  await ime.select(ime.view().candidates.indexOf('漢字'));
  assert.deepEqual(out, []); // 漢字 is not a candidate of かん
  assert.equal(ime.view().candidates[0], '缶');
});

test('the caret position survives a live query', async () => {
  const engine = fakeEngine({ あいう: ['藍鵜'] });
  const { ime, fire } = setup(engine);
  await ime.kanaText('あいう');
  await ime.arrow('left');
  await fire();
  assert.equal(engine.state.cursor, 2);
  await ime.kanaText('か');
  assert.equal(ime.view().preedit, 'あいかう');
  assert.equal(engine.state.preedit, 'あいかう');
});

test('explicit 変換 still shows the segment lookup table', async () => {
  const engine = fakeEngine(SENTENCE);
  const { ime, fire } = setup(engine);
  await ime.kanaText('きょうはいいてんき');
  await fire();
  await ime.space();
  const v = ime.view();
  assert.equal(v.source, 'lookup');
  assert.deepEqual(v.candidates, ['今日は', '京は', 'キョウハ', 'きょうは']);
  assert.equal(v.selected, 0);
});

test('an out-of-sync engine after a query is retyped from the mirror', async () => {
  const engine = fakeEngine({ あ: ['亜'] });
  const { ime, fire, warnings } = setup(engine);
  await ime.kanaText('あい');
  const press = engine.press;
  // Simulate anthy losing the reading on Escape.
  engine.press = async (strokes) => {
    const r = await press(strokes);
    if (strokes.some((s) => s.keyval === KEYSYM.Escape)) engine.state.preedit = '';
    return r;
  };
  await fire();
  engine.press = press;
  assert.ok(warnings.some((w) => w.includes('out of sync')));
  assert.equal(ime.liveInfo().resyncs >= 1, true);
});

test('a late visible table (anthy left converting) is closed before the next key is typed', async () => {
  const engine = fakeEngine({}, { あ: ['愛'] });
  const { ime, out } = setup(engine);
  await ime.kanaText('あ');
  // Simulate a prediction table that arrived after the query stopped waiting.
  await engine.press([{ keyval: KEYSYM.Tab, state: 0 }]);
  assert.equal(engine.state.lutVisible, true);
  engine.strokes.length = 0;
  await ime.kanaText('い');
  assert.deepEqual(engine.strokes.slice(0, 1), ['ESC']);
  assert.equal(engine.state.preedit, 'あい');
  assert.deepEqual(out, []);
});
