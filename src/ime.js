// Input method controller: decides what each key does while idle, composing kana, or converting,
// and drives a conversion engine (ibus.js on the device, a fake in tests).
//
// States
//   idle        nothing composed; keys go straight to the target through the direct composer
//   composing   kana typed but not converted; our mirror (mirror.js) is the source of truth and every
//               edit is replayed into anthy as romaji / BackSpace / Left / Right strokes
//   converting  after 変換 (space); anthy owns the text; we show its preedit and lookup table
//
// Nothing reaches the target until the engine emits commit-text (or we fall back to direct input).
// All public methods are queued, so fast input is applied in order even though IBus calls are async.
//
// Live candidates (while composing): once the reading has been quiet for `liveDelayMs`, a query runs
// in the same queue on the same input context: 変換 (space) -> read the preedit (whole sentence) and
// the first segment's lookup table -> Escape back to the reading; then Tab (predict) -> read the
// predictions -> Escape. Measured on the device: space ~14 ms, Escape ~4 ms, and Escape restores the
// reading with the caret where it was. A second input context would not help: IBus has one global
// engine that follows focus, and anthy resets the composition on focus-out. Any key pressed during a
// query bumps a generation counter, so the query stops after its current step and the key runs
// next. After every query we check that anthy's preedit and caret still equal our mirror, and
// retype the mirror if not.
import { createDebouncer, createGeneration, mergeCandidates } from './live.js';
import { mirrorOf, mirrorText, applyOps, EMPTY_MIRROR } from './mirror.js';
import { KEYSYM, SHIFT_MASK, stroke, textToStrokes } from './romaji.js';

/** How long to wait for anthy's lookup table after 変換 / Escape (normally < 20 ms). */
const LUT_TIMEOUT_MS = 300;
/** How long to wait for a prediction table after Tab. With no prediction anthy sends no signal at all. */
const PREDICT_WAIT_MS = 50;
/**
 * When a key is waiting, stop waiting for predictions after this long. Prediction tables arrived
 * ~5 ms after Tab on the device; a later one is caught by the guards in handleUpdate/applyCompose.
 */
const PREDICT_MIN_WAIT_MS = 25;

/**
 * @typedef {import('./romaji.js').KeyStroke} KeyStroke
 * @typedef {import('./mirror.js').Mirror} Mirror
 * @typedef {import('./composer.js').OutputOp} OutputOp
 * @typedef {import('./live.js').LiveCandidate} LiveCandidate
 * @typedef {ReturnType<typeof import('./composer.js').createComposer>} Composer
 */

/**
 * @typedef {object} EngineState
 * @property {string} preedit - Preedit text as shown by the engine
 * @property {number} cursor - Preedit cursor (start of the current segment while converting)
 * @property {string[]} candidates - All candidates of the lookup table
 * @property {number} candidateCursor - Selected candidate (absolute index)
 * @property {number} pageSize - Lookup table page size
 * @property {boolean} lutVisible - Lookup table is shown
 * @property {number} lutSignals - Number of update-lookup-table signals received
 * @property {number} lutApplied - Serial of the last lookup table read completely into this state
 */

/**
 * @typedef {object} Engine
 * @property {EngineState} state - Latest state reported by the engine's signals
 * @property {() => Promise<void>} acquire - Make our context the active one with anthy (idempotent)
 * @property {(strokes: KeyStroke[]) => Promise<boolean[]>} press - Send key strokes in order; resolves with "handled" per stroke
 * @property {(predicate: (s: EngineState) => boolean, timeoutMs: number) => Promise<boolean>} waitFor - Wait for a state condition (false on timeout)
 * @property {() => Promise<void>} settle - Wait until the engine's signals have been delivered
 * @property {() => Promise<void>} reset - Discard the engine's composition without committing
 * @property {() => Promise<void>} release - Reset, give focus back, restore the global engine
 */

/**
 * @typedef {object} ImeView
 * @property {'direct'|'idle'|'composing'|'converting'} phase - Current phase ("direct" = no conversion engine)
 * @property {string} preedit - Text being composed
 * @property {number} caret - Caret inside the preedit while composing
 * @property {number} segStart - Start of the current segment while converting
 * @property {number} segLength - Length of the current segment while converting (0 = unknown)
 * @property {string[]} candidates - Candidates to show
 * @property {number} selected - Selected candidate index (-1 = none)
 * @property {'live'|'lookup'|'none'} source - Live candidates while composing, anthy's lookup table while converting
 */

/**
 * Create the input method controller.
 * @param {object} options - Options
 * @param {Engine|null} options.engine - Conversion engine, or null for direct hiragana input
 * @param {Composer} options.direct - Composer that types straight into the target
 * @param {Composer} options.compose - Composer for the kana being composed
 * @param {(ops: OutputOp[]) => void} options.send - Delivers operations to the target
 * @param {() => void} [options.onChange] - Called when the view may have changed
 * @param {(...args: unknown[]) => void} [options.warn] - Warning logger
 * @param {number} [options.liveDelayMs=150] - Quiet time before live candidates are computed
 * @param {boolean} [options.predictions=true] - Ask anthy for (history-based) predictions too
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer] - Timer (injectable for tests)
 * @param {(id: unknown) => void} [options.clearTimer] - Timer cancel (injectable for tests)
 * @param {() => number} [options.now] - Clock in ms (for latency statistics)
 * @returns {{
 *   kana: (keyId: string, direction: string) => Promise<void>,
 *   kanaText: (text: string) => Promise<void>,
 *   text: (text: string|(() => string)) => Promise<void>,
 *   modify: () => Promise<void>,
 *   backspace: () => Promise<void>,
 *   undo: () => Promise<void>,
 *   arrow: (direction: 'left'|'right') => Promise<void>,
 *   space: () => Promise<void>,
 *   enter: () => Promise<void>,
 *   select: (index: number, text?: string) => Promise<void>,
 *   replaceTail: (count: () => number, text: string) => Promise<void>,
 *   commitAll: () => Promise<void>,
 *   discard: () => Promise<void>,
 *   release: () => Promise<void>,
 *   disableEngine: (reason: string) => void,
 *   attachEngine: (engine: Engine) => void,
 *   handleCommit: (text: string) => void,
 *   handleUpdate: () => void,
 *   view: () => ImeView,
 *   flush: () => Promise<void>,
 *   liveInfo: () => object,
 *   readonly busy: boolean,
 * }} The controller
 * @example
 * const ime = createIme({ engine, direct, compose, send });
 * await ime.kana('ka', 'center'); // composing "か"
 * await ime.space(); // converting
 * await ime.enter(); // commits through send()
 */
export const createIme = ({
  engine,
  direct,
  compose,
  send,
  onChange = () => {},
  warn = () => {},
  liveDelayMs = 150,
  predictions = true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => performance.now(),
}) => {
  let active = engine;
  /** @type {Mirror} */
  let mirror = EMPTY_MIRROR;
  let converting = false;
  let pending = 0;
  /** @type {Promise<void>} */
  let queue = Promise.resolve();
  /** Bumped synchronously by every user action; live queries stop when it moves. */
  const generation = createGeneration();
  const debouncer = createDebouncer({ delayMs: liveDelayMs, setTimer, clearTimer });
  /** @type {{reading: string, items: LiveCandidate[]}} */
  let live = { reading: '', items: [] };
  let querying = false;
  let resyncQueued = false;
  const stats = { queries: 0, aborted: 0, resyncs: 0, lastMs: 0, lastPredictMs: 0, maxKeyWaitMs: 0, keyWaits: [] };

  /**
   * Whether anything is being composed or converted.
   * @returns {boolean} True while the engine holds text
   * @example
   * isComposing()
   */
  const isComposing = () => converting || mirror.chars.length > 0;

  /**
   * Forget the composition state (the engine must already be empty).
   * @returns {void}
   * @example
   * clearComposition()
   */
  const clearComposition = () => {
    mirror = EMPTY_MIRROR;
    converting = false;
    compose.reset();
    live = { reading: '', items: [] };
    debouncer.cancel();
  };

  /**
   * Stop using the engine for the rest of this session and type directly instead.
   * Whatever was being composed is typed into the target as shown, so nothing is lost.
   * @param {string} reason - Why (logged)
   * @returns {void}
   * @example
   * disableEngine('IBus call failed')
   */
  const disableEngine = (reason) => {
    if (!active) return;
    const shown = converting ? active.state.preedit : mirrorText(mirror);
    const failed = active;
    active = null;
    warn(`conversion disabled, typing hiragana directly: ${reason}`);
    clearComposition();
    if (shown) send(direct.typeText(shown));
    failed.reset().catch(() => {});
    onChange();
  };

  /**
   * Run a task after the previous ones. A failing engine call switches to direct input.
   * User tasks bump the generation right away, so a running live query yields to them.
   * @param {() => Promise<void>|void} task - Task
   * @param {boolean} [user=true] - A user action (false for background live queries)
   * @returns {Promise<void>} Resolves when the task is done
   * @example
   * enqueue(async () => {})
   */
  const enqueue = (task, user = true) => {
    pending += 1;
    const calledAt = now();
    if (user) generation.bump();
    const run = queue.then(() => {
      if (user) {
        const wait = now() - calledAt;
        stats.maxKeyWaitMs = Math.max(stats.maxKeyWaitMs, wait);
        stats.keyWaits = [...stats.keyWaits, Math.round(wait * 10) / 10].slice(-50);
      }
      return task();
    }).catch((error) => {
      disableEngine(`${error?.message ?? error}`);
    }).finally(() => {
      pending -= 1;
      if (user) scheduleLive();
      onChange();
    });
    queue = run;
    return run;
  };

  /**
   * Start using an engine that finished initializing after the controller was created.
   * @param {Engine} value - The engine
   * @returns {void}
   * @example
   * attachEngine(engine)
   */
  const attachEngine = (value) => {
    enqueue(() => {
      if (active || !value) return;
      active = value;
      clearComposition();
    });
  };

  /**
   * Check that anthy's preedit and caret equal our mirror.
   * @returns {boolean} True when in sync
   * @example
   * inSync()
   */
  const inSync = () => active.state.preedit === mirrorText(mirror) && active.state.cursor === mirror.caret;

  /**
   * Put the mirror back into anthy from scratch (reset, retype, move the caret).
   * @returns {Promise<void>} Resolves when retyped
   * @example
   * await resync()
   */
  const resync = async () => {
    stats.resyncs += 1;
    warn('anthy was out of sync with the composition; retyping it');
    await active.reset();
    const { strokes } = textToStrokes(mirrorText(mirror));
    const lefts = Array.from({ length: mirror.chars.length - mirror.caret }, () => stroke(KEYSYM.Left));
    await active.press([...strokes, ...lefts]);
    await active.settle();
  };

  /**
   * Press one key and wait for the lookup table it causes. Every keystroke also produces an
   * (invisible) table update that can arrive late, so we wait for the expected visibility:
   * 変換 and Tab open a visible table, Escape hides it.
   * @param {KeyStroke} key - Key stroke
   * @param {boolean} visible - Expected visibility of the table
   * @param {number} timeoutMs - How long to wait for the table's signal
   * @param {(elapsed: number, signalled: boolean) => boolean} [giveUp] - Checked every few ms; true stops waiting early
   * @returns {Promise<{handled: boolean, updated: boolean}>} Whether the key was handled and the table arrived
   * @example
   * await pressForTable(stroke(KEYSYM.space), true, LUT_TIMEOUT_MS)
   */
  const pressForTable = async (key, visible, timeoutMs, giveUp = () => false) => {
    const before = active.state.lutSignals;
    const t0 = now();
    const [handled] = await active.press([key]);
    if (!handled) return { handled, updated: false };
    const start = now();
    stats.lastSteps = [...(stats.lastSteps ?? []).slice(-5), { key: key.keyval.toString(16), pressMs: Math.round(start - t0) }];
    /**
     * The expected table has been read completely.
     * @param {EngineState} st - Engine state
     * @returns {boolean} True when it arrived
     * @example
     * arrived(active.state)
     */
    const arrived = (st) => st.lutApplied > before && st.lutVisible === visible;
    while (!arrived(active.state)) {
      const elapsed = now() - start;
      if (elapsed >= timeoutMs || giveUp(elapsed, active.state.lutSignals > before)) break;
      await active.waitFor(arrived, 5);
    }
    stats.lastSteps.at(-1).waitMs = Math.round(now() - start);
    return { handled, updated: arrived(active.state) };
  };

  /**
   * Leave a peek (conversion or prediction) with Escape and check that the reading is intact.
   * @returns {Promise<boolean>} True when anthy is back on our reading
   * @example
   * await backToReading()
   */
  const backToReading = async () => {
    await pressForTable(stroke(KEYSYM.Escape), false, LUT_TIMEOUT_MS);
    return inSync();
  };

  /**
   * Compute live candidates for the current reading (runs inside the queue).
   * @param {number} gen - Generation when the query was scheduled
   * @returns {Promise<void>} Resolves when done or abandoned
   * @example
   * await liveQuery(generation.current)
   */
  const liveQuery = async (gen) => {
    if (!active || converting || !mirror.chars.length) return;
    const reading = mirrorText(mirror);
    if (reading === live.reading) return;
    if (!generation.isCurrent(gen)) {
      stats.aborted += 1;
      return;
    }
    querying = true;
    try {
      const t0 = now();
      // Giving up on 変換 is always safe: anthy is converting either way, and Escape brings it back.
      const conv = await pressForTable(stroke(KEYSYM.space), true, LUT_TIMEOUT_MS, () => !generation.isCurrent(gen));
      const whole = conv.updated ? active.state.preedit : '';
      const segment = conv.updated ? [...active.state.candidates] : [];
      if (conv.handled && !await backToReading()) {
        await resync();
        return;
      }
      if (!conv.updated && !generation.isCurrent(gen)) {
        stats.aborted += 1;
        return;
      }
      stats.queries += 1;
      stats.lastMs = now() - t0;
      live = { reading, items: mergeCandidates({ reading, whole, segment }) };
      onChange();
      if (!predictions) return;
      if (!generation.isCurrent(gen)) {
        stats.aborted += 1;
        return;
      }
      const t1 = now();
      // Giving up on Tab is only safe while no signal came (anthy stays in input mode then).
      const pred = await pressForTable(stroke(KEYSYM.Tab), true, PREDICT_WAIT_MS, (elapsed, signalled) => !signalled && !generation.isCurrent(gen) && elapsed >= PREDICT_MIN_WAIT_MS);
      const predicted = pred.updated ? [...active.state.candidates] : [];
      if (pred.updated ? !await backToReading() : !inSync()) {
        await resync();
        return;
      }
      stats.lastPredictMs = now() - t1;
      if (predicted.length) {
        live = { reading, items: mergeCandidates({ reading, whole, segment, predictions: predicted }) };
        onChange();
      }
    } finally {
      querying = false;
    }
  };

  /**
   * After a user action: (re)start the debounce for live candidates, or stop it when not composing.
   * @returns {void}
   * @example
   * scheduleLive()
   */
  const scheduleLive = () => {
    if (!active || converting || !mirror.chars.length) {
      debouncer.cancel();
      return;
    }
    if (mirrorText(mirror) === live.reading) return;
    debouncer.schedule(() => {
      const gen = generation.current;
      enqueue(() => liveQuery(gen), false);
    });
  };

  /**
   * Apply composer ops to the composition and replay them into the engine.
   * @param {OutputOp[]} ops - Ops from the compose composer
   * @returns {Promise<void>} Resolves when the engine has the strokes
   * @example
   * await applyCompose(compose.input('ka', 'center'))
   */
  const applyCompose = async (ops) => {
    if (!ops.length) return;
    if (mirror.chars.length === 0) await active.acquire();
    // A late prediction/conversion table means anthy is not in plain input: leave it before typing,
    // so our strokes can never select (and commit) something the user did not pick.
    else if (!converting && active.state.lutVisible && !await backToReading()) await resync();
    const result = applyOps(mirror, ops);
    mirror = result.mirror;
    if (result.skipped.length) warn(`cannot type through anthy, skipped ${result.skipped.length} character(s)`);
    if (!mirror.chars.length) live = { reading: '', items: [] };
    onChange();
    await active.press(result.strokes);
  };

  /**
   * Commit everything the engine holds (Enter), and wait for commit-text to be delivered.
   * @returns {Promise<void>} Resolves when committed
   * @example
   * await commitInEngine()
   */
  const commitInEngine = async () => {
    if (!isComposing()) return;
    await active.press([stroke(KEYSYM.Return)]);
    await active.settle();
    clearComposition();
  };

  /**
   * Leave conversion and go back to editing the reading (anthy's cancel = Escape).
   * @returns {Promise<void>} Resolves when the reading has been loaded into the mirror
   * @example
   * await cancelConversion()
   */
  const cancelConversion = async () => {
    await active.press([stroke(KEYSYM.Escape)]);
    await active.settle();
    converting = false;
    const reading = active.state.preedit;
    mirror = mirrorOf(reading);
    compose.load(reading);
    if (!reading) clearComposition();
  };

  /**
   * Type a kana key (tap or flick).
   * @param {string} keyId - Kana key id
   * @param {string} direction - Flick direction
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await kana('a', 'left') // い
   */
  const kana = (keyId, direction) => enqueue(async () => {
    if (!active) {
      send(direct.input(keyId, direction));
      return;
    }
    if (converting) await commitInEngine();
    await applyCompose(compose.input(keyId, direction));
  });

  /**
   * Add kana text to the composition (debug API and tests; same path as a key).
   * @param {string} value - Kana text
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await kanaText('かんじ')
   */
  const kanaText = (value) => enqueue(async () => {
    if (!active) {
      send(direct.typeText(value));
      return;
    }
    if (converting) await commitInEngine();
    await applyCompose(compose.typeText(value));
  });

  /**
   * Type literal text (QWERTY letters, symbols). Commits any composition first.
   * @param {string|(() => string)} value - Text, or a function called when the task runs (so it can
   *   depend on what has been sent before, e.g. auto-capitalization after ". ")
   * @returns {Promise<void>} Resolves when sent
   * @example
   * await text('「')
   */
  const text = (value) => enqueue(async () => {
    if (active) await commitInEngine();
    send(direct.typeText(typeof value === 'function' ? value() : value));
  });

  /**
   * The ゛゜小 key: change the character before the caret. While converting, the conversion is
   * cancelled first so the key works on the reading.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await modify()
   */
  const modify = () => enqueue(async () => {
    if (!active || !isComposing()) {
      send(direct.modify());
      return;
    }
    if (converting) await cancelConversion();
    await applyCompose(compose.modify());
  });

  /**
   * ⌫: delete in the composition, cancel a conversion, or delete in the target when idle.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await backspace()
   */
  const backspace = () => enqueue(async () => {
    if (!active || !isComposing()) {
      send(direct.backspace());
      return;
    }
    if (converting) {
      await cancelConversion();
      return;
    }
    await applyCompose(compose.backspace());
  });

  /**
   * ↶: undo the last kana edit (a conversion is cancelled back to its reading first); when idle,
   * undo the last thing typed into the target.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await undo()
   */
  const undo = () => enqueue(async () => {
    if (!active) {
      send(direct.undo());
      return;
    }
    if (converting) {
      await cancelConversion();
      return;
    }
    const ops = compose.undo();
    if (ops.length) {
      await applyCompose(ops);
      return;
    }
    if (!isComposing()) send(direct.undo());
  });

  /**
   * ← / →: move the caret in the composition, resize the current segment while converting
   * (Shift+Left / Shift+Right in anthy), or move the target's cursor when idle.
   * @param {'left'|'right'} directionName - Direction
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await arrow('left')
   */
  const arrow = (directionName) => enqueue(async () => {
    if (!active || !isComposing()) {
      send(direct.arrow(directionName));
      return;
    }
    if (converting) {
      await active.press([stroke(directionName === 'left' ? KEYSYM.Left : KEYSYM.Right, SHIFT_MASK)]);
      return;
    }
    await applyCompose([{ key: directionName === 'left' ? 'ArrowLeft' : 'ArrowRight' }]);
    // The composer only knows the text before the caret; reload it so ゛゜小 and ⌫ keep working.
    compose.load(mirror.chars.slice(0, mirror.caret).join(''));
  });

  /**
   * 空白: convert, go to the next candidate, or type a space when idle.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await space()
   */
  const space = () => enqueue(async () => {
    if (!active || !isComposing()) {
      send(direct.typeText(' '));
      return;
    }
    await active.press([stroke(KEYSYM.space)]);
    converting = true;
  });

  /**
   * ⏎: commit the composition; when idle, Enter in the target.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await enter()
   */
  const enter = () => enqueue(async () => {
    if (!active || !isComposing()) {
      send(direct.enter());
      return;
    }
    await commitInEngine();
  });

  /**
   * Move anthy's lookup-table cursor to a candidate with cursor keys (Page_Down/Page_Up, then
   * Down/Up) and check, from the lookup-table signal, that it landed there.
   *
   * Never select with digit keys: in ibus-anthy a digit goes through __commit_nth_segment, which
   * commits the text without anthy's commit_segment, so anthy never learns the choice. Cursor keys
   * set the segment's candidate (do_cursor_down/up, page_down/up), and Return then commits every
   * segment through commit_segment (or commit_prediction), which is what anthy learns from.
   * @param {number} index - Candidate index in the full list
   * @param {string} text - The candidate expected at that index
   * @returns {Promise<boolean>} True when the cursor is on the candidate
   * @example
   * await moveCursorTo(3, '器械')
   */
  const moveCursorTo = async (index, text) => {
    for (let attempt = 0; attempt < 2 && active.state.candidateCursor !== index; attempt += 1) {
      const st = active.state;
      const pageSize = st.pageSize > 0 ? st.pageSize : 5;
      let cursor = st.candidateCursor;
      const keys = [];
      while (index - cursor >= pageSize) {
        keys.push(stroke(KEYSYM.Page_Down));
        cursor += pageSize;
      }
      while (cursor - index >= pageSize) {
        keys.push(stroke(KEYSYM.Page_Up));
        cursor -= pageSize;
      }
      for (; cursor < index; cursor += 1) keys.push(stroke(KEYSYM.Down));
      for (; cursor > index; cursor -= 1) keys.push(stroke(KEYSYM.Up));
      const before = st.lutSignals;
      await active.press(keys);
      await active.waitFor((s) => s.lutApplied > before && s.candidateCursor === index, LUT_TIMEOUT_MS);
    }
    const s = active.state;
    return s.lutVisible && s.candidateCursor === index && s.candidates[index] === text;
  };

  /**
   * Whether the segment being converted is the last one: its candidate ends where the preedit ends.
   * @returns {boolean} True for the last (or only) segment, and for a prediction
   * @example
   * onLastSegment()
   */
  const onLastSegment = () => {
    const s = active.state;
    const current = s.candidates[s.candidateCursor] ?? '';
    return s.preedit.startsWith(current, s.cursor) && s.cursor + current.length >= s.preedit.length;
  };

  /**
   * Take a candidate of the lookup table anthy is showing: move the cursor onto it, then either go
   * on to the next segment (Right; still converting, the panel shows that segment's candidates) or,
   * on the last segment, commit everything with Return so anthy learns every segment.
   * @param {number} index - Candidate index in the full list
   * @param {string} [text] - The candidate the user saw (defaults to the one at index now)
   * @param {boolean} [commitAll=false] - Always commit with Return (predictions replace the whole reading)
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await pickInLookup(3, '器械')
   */
  const pickInLookup = async (index, text, commitAll = false) => {
    const { candidates } = active.state;
    const wanted = text ?? candidates[index];
    const at = candidates[index] === wanted ? index : candidates.indexOf(wanted);
    if (!wanted || at < 0) return;
    if (!await moveCursorTo(at, wanted)) {
      warn('candidate cursor did not reach the tapped candidate; nothing committed');
      return;
    }
    if (commitAll || onLastSegment()) {
      await commitInEngine();
      return;
    }
    const before = active.state.lutSignals;
    await active.press([stroke(KEYSYM.Right)]);
    await active.waitFor((s) => s.lutApplied > before && s.lutVisible, LUT_TIMEOUT_MS);
  };

  /**
   * Commit text without anthy (katakana, or when anthy's table changed unexpectedly).
   * @param {string} value - Text
   * @returns {Promise<void>} Resolves when sent
   * @example
   * await commitDirect('カンジ')
   */
  const commitDirect = async (value) => {
    await active.reset();
    clearComposition();
    send(direct.typeText(value));
  };

  /**
   * Commit a live candidate. Everything anthy produced is committed through anthy with Return, so
   * anthy learns it: the whole sentence (変換, then Return), a first-segment candidate (変換, cursor
   * onto it, then as for a tap during conversion: next segment, or Return on the last one) and a
   * prediction (Tab, cursor onto it, Return = commit_prediction). The hiragana reading is committed
   * with Return as typed, and katakana directly (nothing to learn).
   * @param {number} index - Index in the live list
   * @returns {Promise<void>} Resolves when committed
   * @example
   * await pickLive(0)
   */
  const pickLive = async (index) => {
    let item = live.items[index];
    if (!item) return;
    if (live.reading !== mirrorText(mirror)) {
      // The list on screen was for an older reading: refresh, then look the same text up again.
      const wanted = item;
      live = { reading: '', items: [] };
      await liveQuery(generation.current);
      item = live.items.find((c) => c.text === wanted.text && c.kind === wanted.kind) ?? live.items.find((c) => c.text === wanted.text);
      if (!item) return;
    }
    if (item.kind === 'katakana') {
      await commitDirect(item.text);
      return;
    }
    if (item.kind === 'hiragana') {
      await commitInEngine();
      return;
    }
    const opened = await pressForTable(stroke(item.kind === 'prediction' ? KEYSYM.Tab : KEYSYM.space), true, LUT_TIMEOUT_MS);
    if (!opened.updated) {
      await commitDirect(item.text);
      return;
    }
    converting = true;
    if (item.kind === 'whole') {
      if (active.state.preedit === item.text) await commitInEngine();
      else await commitDirect(item.text);
      return;
    }
    const at = active.state.candidates.indexOf(item.text);
    if (at < 0) {
      await cancelConversion();
      return;
    }
    await pickInLookup(at, item.text, item.kind === 'prediction');
  };

  /**
   * Tap on a candidate: a live candidate while composing, or anthy's lookup table while converting.
   * @param {number} index - Candidate index as shown
   * @param {string} [text] - The candidate as shown (guards against a table that changed meanwhile)
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await select(3, '器械')
   */
  const select = (index, text) => enqueue(async () => {
    if (!active) return;
    if (converting) {
      await pickInLookup(index, text);
      return;
    }
    if (mirror.chars.length) await pickLive(index);
  });

  /**
   * Replace text right before the cursor (English suggestions). The count is read when the task
   * runs, so it matches exactly what has been sent by then.
   * @param {() => number} count - Returns how many characters to delete
   * @param {string} value - Replacement text
   * @returns {Promise<void>} Resolves when sent
   * @example
   * await replaceTail(() => 4, 'hello ')
   */
  const replaceTail = (count, value) => enqueue(async () => {
    if (active) await commitInEngine();
    send(direct.replace(count(), value));
  });

  /**
   * Commit whatever is being composed (before switching modes, typing a symbol, etc.).
   * @returns {Promise<void>} Resolves when committed
   * @example
   * await commitAll()
   */
  const commitAll = () => enqueue(async () => {
    if (active) await commitInEngine();
  });

  /**
   * Throw away the composition without committing (keyboard closed).
   * @returns {Promise<void>} Resolves when discarded
   * @example
   * await discard()
   */
  const discard = () => enqueue(async () => {
    direct.reset();
    if (!active) return;
    if (isComposing()) await active.reset();
    clearComposition();
  });

  /**
   * Discard the composition and hand IBus back to the stock keyboard.
   * @returns {Promise<void>} Resolves when released
   * @example
   * await release()
   */
  const release = () => enqueue(async () => {
    direct.reset();
    clearComposition();
    if (active) await active.release();
  });

  /**
   * Engine signal: text committed by the engine goes to the target.
   * @param {string} value - Committed text
   * @returns {void}
   * @example
   * handleCommit('漢字')
   */
  const handleCommit = (value) => {
    if (value) send(direct.typeText(value));
  };

  /**
   * Engine signal: preedit or candidates changed. A visible lookup table outside a query or a
   * conversion means a late signal left anthy converting (e.g. a prediction that arrived after we
   * stopped waiting); the reading is then put back.
   * @returns {void}
   * @example
   * handleUpdate()
   */
  const handleUpdate = () => {
    if (active && !querying && !converting && !resyncQueued && mirror.chars.length && active.state.lutVisible) {
      resyncQueued = true;
      enqueue(async () => {
        resyncQueued = false;
        if (!converting && mirror.chars.length && active.state.lutVisible && !await backToReading()) await resync();
      }, false);
    }
    onChange();
  };

  /**
   * Describe what the candidate area should show.
   * @returns {ImeView} The view
   * @example
   * view().candidates
   */
  const view = () => {
    const none = { preedit: '', caret: 0, segStart: 0, segLength: 0, candidates: [], selected: -1, source: 'none' };
    if (!active) return { phase: 'direct', ...none };
    if (converting) {
      const s = active.state;
      const candidates = s.lutVisible ? s.candidates : [];
      const current = s.candidates[s.candidateCursor] ?? '';
      const segLength = current && s.preedit.startsWith(current, s.cursor) ? Array.from(current).length : 0;
      return {
        phase: 'converting',
        preedit: s.preedit,
        caret: s.cursor,
        segStart: Array.from(s.preedit.slice(0, s.cursor)).length,
        segLength,
        candidates,
        selected: candidates.length ? s.candidateCursor : -1,
        source: 'lookup',
      };
    }
    if (mirror.chars.length) {
      return {
        ...none,
        phase: 'composing',
        preedit: mirrorText(mirror),
        caret: mirror.caret,
        candidates: live.items.map((c) => c.text),
        source: 'live',
      };
    }
    return { phase: 'idle', ...none };
  };

  return {
    kana,
    kanaText,
    text,
    modify,
    backspace,
    undo,
    arrow,
    space,
    enter,
    select,
    replaceTail,
    commitAll,
    discard,
    release,
    disableEngine,
    attachEngine,
    handleCommit,
    handleUpdate,
    view,
    /**
     * Wait until every queued call has finished.
     * @returns {Promise<void>} Resolves when the queue is empty
     * @example
     * await flush()
     */
    flush: () => queue,
    /**
     * Live-candidate state and timing statistics (debug API).
     * @returns {object} Info
     * @example
     * liveInfo().lastMs
     */
    liveInfo: () => ({
      reading: live.reading,
      fresh: live.reading === mirrorText(mirror),
      items: live.items.map((c) => `${c.text}(${c.kind})`),
      ...stats,
      keyWaits: [...stats.keyWaits],
    }),
    get busy() {
      return pending > 0;
    },
  };
};
