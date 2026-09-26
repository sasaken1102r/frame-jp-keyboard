// Conversion engine backed by Steam's native IBus binding (the globals `IBus`, created by the Steam
// client in SharedJSContext). We only call the runtime objects, the same way the stock keyboard does:
//   IBus.bus_new() -> bus.create_input_context(name) -> ctx.set_capabilities / focus_in /
//   process_key_event(keyval, keycode, state) / reset / focus_out / property_activate,
//   ctx.connect(signal, fn) -> handle.unregister(), bus.get_global_engine / set_global_engine.
//
// Behaviour measured on the device (IBus 1.5.32, ibus-anthy, 2026-09-26):
//   - IBus runs in global-engine mode: one engine instance follows the focused input context.
//     Focusing our context moves anthy to it; the stock keyboard's context gets the engine back by
//     itself on its next process_key_event (IBus focuses a real context that sends keys).
//   - ctx.set_engine() on the focused context changes the *global* engine. So when the stock keyboard
//     is in English (xkb:us::eng) we switch to anthy while composing and switch back on release.
//   - Signals arrive shortly after the process_key_event promise resolves, so callers use settle()
//     when they need the result of a key (commit-text, preedit after Escape).
//   - anthy's lookup table carries all candidates (get_number_of_candidates is not per page); we
//     read at most MAX_CANDIDATES of them.
import { log, warn } from './log.js';

const CONTEXT_NAME = 'frame-jp-keyboard';
const ENGINE_NAME = 'anthy';
const SETTLE_QUIET_MS = 30;
const SETTLE_MAX_MS = 400;
/** anthy properties our romaji strokes depend on (the engine instance is shared with the stock keyboard). */
const REQUIRED_PROPERTIES = Object.freeze(['TypingMode.Romaji', 'InputMode.Hiragana']);
/**
 * Candidates read per lookup table. Reading costs ~1 ms per candidate over the binding (measured:
 * き has 139 candidates, 145 ms), so we read the first ones plus up to the selected one.
 */
const MAX_CANDIDATES = 30;
/**
 * Candidates requested per round trip (~15 ms each). The binding runs calls in order, so a key waits for
 * every get_candidate already sent; chunks let a newer table (or our Escape) cut in. 16 fills two rows.
 */
const CANDIDATE_CHUNK = 16;
/** Survives re-injection, so we reuse one bus connection and one input context. */
const GLOBAL_KEY = '__fjkIBus';

/**
 * @typedef {import('./ime.js').EngineState} EngineState
 * @typedef {import('./romaji.js').KeyStroke} KeyStroke
 */

/**
 * Wait for a number of milliseconds.
 * @param {number} ms - Delay
 * @returns {Promise<void>} Resolves after the delay
 * @example
 * await sleep(10)
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read an engine description's name.
 * @param {any} desc - IBusEngineDesc or null
 * @returns {Promise<string|null>} Engine name
 * @example
 * await engineName(await bus.get_global_engine()) // "anthy"
 */
const engineName = async (desc) => (desc ? await desc.get_name() : null);

/**
 * Create the IBus/anthy conversion engine. Call init() before use; it resolves false when IBus or
 * anthy is not available (the caller then types hiragana directly).
 * @param {object} callbacks - Signal callbacks
 * @param {(text: string) => void} callbacks.onCommit - commit-text
 * @param {() => void} callbacks.onUpdate - Preedit or lookup table changed
 * @returns {import('./ime.js').Engine & {init: () => Promise<boolean>, destroy: () => Promise<void>, readonly info: object}} The engine
 * @example
 * const engine = createIBusEngine({ onCommit: (t) => console.log(t), onUpdate: () => {} });
 * if (await engine.init()) await engine.press([{ keyval: 0x61, state: 0 }]);
 */
export const createIBusEngine = ({ onCommit, onUpdate }) => {
  /** @type {EngineState} */
  const state = {
    preedit: '',
    cursor: 0,
    candidates: [],
    candidateCursor: 0,
    pageSize: 5,
    lutVisible: false,
    candidateTotal: 0,
    lutSignals: 0,
    lutApplied: 0,
  };
  /** @type {Set<() => void>} Waiters re-checked on every signal (see waitFor). */
  const waiters = new Set();
  let bus = null;
  let ctx = null;
  /** @type {{unregister: () => void}[]} */
  let handles = [];
  let acquired = false;
  /** Global engine to restore on release, when we changed it. */
  let previousEngine = null;
  let lastSignalAt = 0;
  let lutSeq = 0;
  /** Keys sent, by kind (debug: shows that previews never send Return or digits). */
  const keyCounts = { Return: 0, Escape: 0, space: 0, Tab: 0, digit: 0, cursor: 0, other: 0 };

  /**
   * Count a key stroke by kind.
   * @param {number} keyval - X keysym
   * @returns {void}
   * @example
   * countKey(0xff0d)
   */
  const countKey = (keyval) => {
    const kind = { 0xff0d: 'Return', 0xff1b: 'Escape', 0x20: 'space', 0xff09: 'Tab' }[keyval]
      ?? (keyval >= 0x30 && keyval <= 0x39 ? 'digit' : [0xff52, 0xff54, 0xff55, 0xff56, 0xff53].includes(keyval) ? 'cursor' : 'other');
    keyCounts[kind] += 1;
  };
  let destroyed = false;

  /**
   * Note that a signal arrived.
   * @returns {void}
   * @example
   * touch()
   */
  const touch = () => {
    lastSignalAt = performance.now();
    for (const check of [...waiters]) check();
  };

  /**
   * Walk an IBusPropList (and sub-lists) and make sure romaji typing and hiragana input are on.
   * @param {any} props - IBusPropList
   * @returns {Promise<void>} Resolves when checked
   * @example
   * await fixProperties(props)
   */
  const fixProperties = async (props) => {
    for (let i = 0; ; i += 1) {
      const prop = await props.get(i);
      if (!prop) break;
      await fixProperty(prop);
      const sub = await prop.get_sub_props();
      if (sub) await fixProperties(sub);
    }
  };

  /**
   * Activate a required radio property when anthy reports it as off (e.g. the stock keyboard's
   * kana layout switched the shared engine to kana typing).
   * @param {any} prop - IBusProperty
   * @returns {Promise<void>} Resolves when checked
   * @example
   * await fixProperty(prop)
   */
  const fixProperty = async (prop) => {
    if (!acquired || !ctx) return;
    const [key, propState] = await Promise.all([prop.get_key(), prop.get_state()]);
    if (REQUIRED_PROPERTIES.includes(key) && propState !== 1) {
      log(`anthy ${key} was off; activating it`);
      await ctx.property_activate(key, 1);
    }
  };

  /**
   * Read the whole lookup table. Reads can overlap; only the newest one is applied.
   * @param {any} table - IBusLookupTable
   * @param {unknown} visible - Visibility flag from the signal
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await readLookupTable(table, 1)
   */
  const readLookupTable = async (table, visible) => {
    const seq = ++lutSeq;
    state.lutSignals = seq;
    let count;
    let cursor;
    let pageSize;
    let candidates;
    try {
      [count, cursor, pageSize] = await Promise.all([
        table.get_number_of_candidates(),
        table.get_cursor_pos(),
        table.get_page_size(),
      ]);
      const wanted = Math.min(count, Math.max(MAX_CANDIDATES, cursor + (pageSize || 5)));
      candidates = [];
      for (let i = 0; i < wanted; i += CANDIDATE_CHUNK) {
        if (seq !== lutSeq) return; // A newer table arrived; stop reading this one.
        const n = Math.min(CANDIDATE_CHUNK, wanted - i);
        candidates.push(...await Promise.all(Array.from({ length: n }, (_, k) => table.get_candidate(i + k))));
      }
    } catch (error) {
      // A newer table can replace this one while we read it; the native object is then gone.
      if (seq === lutSeq) throw error;
      return;
    }
    if (seq !== lutSeq) return;
    Object.assign(state, {
      candidates: candidates.map((c) => String(c ?? '')),
      candidateCursor: cursor,
      pageSize: pageSize || 5,
      lutVisible: !!visible && count > 0,
      candidateTotal: count,
      lutApplied: seq,
    });
    touch();
    onUpdate();
  };

  /**
   * Connect our signal handlers to the context.
   * @returns {Promise<void>} Resolves when connected
   * @example
   * await connectSignals()
   */
  const connectSignals = async () => {
    /**
     * Wrap a signal handler: note the time and never let an exception escape into the binding.
     * @param {string} name - Signal name (for the log)
     * @param {(...args: any[]) => unknown} fn - Handler
     * @returns {(...args: any[]) => void} Wrapped handler
     * @example
     * guard('commit-text', (t) => onCommit(t))
     */
    const guard = (name, fn) => (...args) => {
      touch();
      try {
        const result = fn(...args);
        if (result && typeof result.catch === 'function') result.catch((error) => warn(`${name} handler failed`, error));
      } catch (error) {
        warn(`${name} handler failed`, error);
      }
    };
    handles = await Promise.all([
      ctx.connect('commit-text', guard('commit-text', (text) => onCommit(String(text ?? '')))),
      ctx.connect('update-preedit-text', guard('update-preedit-text', (text, cursor) => {
        state.preedit = String(text ?? '');
        state.cursor = Number(cursor) || 0;
        onUpdate();
      })),
      ctx.connect('hide-preedit-text', guard('hide-preedit-text', () => {
        state.preedit = '';
        state.cursor = 0;
        onUpdate();
      })),
      ctx.connect('update-lookup-table', guard('update-lookup-table', (table, visible) => readLookupTable(table, visible))),
      ctx.connect('show-lookup-table', guard('show-lookup-table', () => {
        state.lutVisible = state.candidates.length > 0;
        onUpdate();
      })),
      ctx.connect('hide-lookup-table', guard('hide-lookup-table', () => {
        state.lutVisible = false;
        onUpdate();
      })),
      ctx.connect('register-properties', guard('register-properties', (props) => fixProperties(props))),
      ctx.connect('update-property', guard('update-property', (prop) => fixProperty(prop))),
    ]);
  };

  /**
   * Connect to IBus, check that anthy exists, and create (or reuse) our input context.
   * @returns {Promise<boolean>} True when conversion is available
   * @example
   * await init()
   */
  const init = async () => {
    try {
      const IBus = globalThis.IBus;
      if (typeof IBus?.bus_new !== 'function') {
        warn('IBus binding not present (window.IBus); conversion unavailable');
        return false;
      }
      const saved = globalThis[GLOBAL_KEY];
      bus = saved?.bus ?? await IBus.bus_new();
      if (!await bus.is_connected()) {
        warn('IBus daemon not connected; conversion unavailable');
        return false;
      }
      const engines = await bus.get_engines_by_names([ENGINE_NAME]);
      if (!engines?.length) {
        warn(`IBus engine "${ENGINE_NAME}" not installed; conversion unavailable`);
        return false;
      }
      ctx = saved?.ctx ?? await bus.create_input_context(CONTEXT_NAME);
      if (!ctx) {
        warn('create_input_context failed; conversion unavailable');
        return false;
      }
      globalThis[GLOBAL_KEY] = { bus, ctx };
      const C = IBus.Capabilite;
      await ctx.set_capabilities(C.PREEDIT_TEXT | C.LOOKUP_TABLE | C.FOCUS | C.PROPERTY);
      await connectSignals();
      log(`IBus conversion ready (${ENGINE_NAME}${saved ? ', reused context' : ''})`);
      return true;
    } catch (error) {
      warn('IBus init failed; conversion unavailable', error);
      return false;
    }
  };

  /**
   * Make our context the focused one and make sure the global engine is anthy. Remembers the
   * previous global engine the first time we change it, so release() can put it back.
   * @returns {Promise<void>} Resolves when ready for key strokes
   * @example
   * await acquire()
   */
  const acquire = async () => {
    if (!ctx || destroyed) throw new Error('IBus context missing');
    const firstTime = !acquired;
    acquired = true;
    // A no-op when we already have focus; takes it back if the stock keyboard's context took it.
    await ctx.focus_in();
    const current = await engineName(await bus.get_global_engine());
    if (current !== ENGINE_NAME) {
      if (previousEngine === null) previousEngine = current;
      log(`switching IBus engine ${current} -> ${ENGINE_NAME} while composing`);
      await ctx.set_engine(ENGINE_NAME);
    }
    if (firstTime || current !== ENGINE_NAME) await settle();
  };

  /**
   * Send key strokes one after another (key presses only, like the stock keyboard).
   * @param {KeyStroke[]} strokes - Strokes
   * @returns {Promise<boolean[]>} Whether the engine handled each stroke
   * @example
   * await press([{ keyval: 0x20, state: 0 }]) // [true]
   */
  const press = async (strokes) => {
    if (!ctx || destroyed) throw new Error('IBus context missing');
    const handled = [];
    for (const s of strokes) {
      countKey(s.keyval);
      handled.push(!!await ctx.process_key_event(s.keyval, 0, s.state));
    }
    return handled;
  };

  /**
   * Wait until a condition on the engine state holds, re-checking on every signal.
   * @param {(s: EngineState) => boolean} predicate - Condition
   * @param {number} timeoutMs - Give up after this long
   * @returns {Promise<boolean>} True when the condition held, false on timeout
   * @example
   * await waitFor((s) => s.lutApplied > before, 300)
   */
  const waitFor = (predicate, timeoutMs) => new Promise((resolve) => {
    if (predicate(state)) {
      resolve(true);
      return;
    }
    let timer;
    /**
     * Resolve once the condition holds.
     * @returns {void}
     * @example
     * check()
     */
    const check = () => {
      if (!predicate(state)) return;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      waiters.delete(check);
      resolve(predicate(state));
    }, timeoutMs);
    waiters.add(check);
  });

  /**
   * Wait until no signal has arrived for a short while (or a maximum time passed).
   * @returns {Promise<void>} Resolves when quiet
   * @example
   * await settle()
   */
  const settle = async () => {
    const start = performance.now();
    await sleep(SETTLE_QUIET_MS);
    while (performance.now() - lastSignalAt < SETTLE_QUIET_MS && performance.now() - start < SETTLE_MAX_MS) {
      await sleep(SETTLE_QUIET_MS / 3);
    }
  };

  /**
   * Discard the composition (anthy's reset never commits with behavior-on-focus-out = 0).
   * @returns {Promise<void>} Resolves when reset
   * @example
   * await reset()
   */
  const reset = async () => {
    if (!ctx) return;
    await ctx.reset();
    Object.assign(state, { preedit: '', cursor: 0, candidates: [], candidateCursor: 0, lutVisible: false });
    onUpdate();
  };

  /**
   * Hand IBus back: reset, unfocus our context, and restore the global engine if we changed it
   * (only when it is still anthy, so a newer choice by the stock keyboard wins).
   * @returns {Promise<void>} Resolves when released
   * @example
   * await release()
   */
  const release = async () => {
    if (!ctx || !acquired) return;
    acquired = false;
    try {
      await reset();
      await ctx.focus_out();
    } finally {
      if (previousEngine !== null) {
        const restore = previousEngine;
        previousEngine = null;
        const current = await engineName(await bus.get_global_engine());
        if (current === ENGINE_NAME) {
          await bus.set_global_engine(restore);
          log(`restored IBus engine ${restore}`);
        }
      }
    }
  };

  /**
   * Release and disconnect our signal handlers (the context itself is kept for re-injection).
   * @returns {Promise<void>} Resolves when done
   * @example
   * await destroy()
   */
  const destroy = async () => {
    try {
      await release();
    } finally {
      destroyed = true;
      for (const handle of handles) {
        try {
          handle.unregister();
        } catch {
          // Already gone.
        }
      }
      handles = [];
    }
  };

  return {
    state,
    init,
    acquire,
    press,
    waitFor,
    settle,
    reset,
    release,
    destroy,
    get info() {
      return { acquired, previousEngine, hasContext: !!ctx, keyCounts: { ...keyCounts } };
    },
  };
};
