// Entry point, evaluated in Steam's SharedJSContext by the injector.
// Idempotent: a previous instance (window.__fjk) is torn down before the new one installs.
// Fail safe: if Steam's objects are missing we log [fjk] warnings and leave the stock keyboard alone.
import { computeBounds } from './bounds.js';
import { createComposer } from './composer.js';
import { WORDS_EN } from './data/words-en.js';
import { createDictionary, createWordTracker, decodeWords, suggest } from './english.js';
import { createIBusEngine } from './ibus.js';
import { createIme } from './ime.js';
import { createKeyboardState } from './keyboard-state.js';
import { log, warn } from './log.js';
import { loadSettings, saveSettings } from './settings.js';
import { createShift } from './shift.js';
import {
  createOutput,
  findVRStatusStore,
  getKeyboardPopupWindow,
  getWebpackRequire,
  missingPrerequisites,
} from './steam.js';
import { mountOverlay } from './ui.js';

/* global __FJK_VERSION__ */
const VERSION = typeof __FJK_VERSION__ === 'string' ? __FJK_VERSION__ : 'dev';
const TICK_MS = 500;
const PREREQ_POLL_MS = 1000;
const PREREQ_TIMEOUT_MS = 180_000;

/**
 * Find where our overlay should sit: over the stock key panel (class "Layout_<name>"), or the popup
 * minus SteamVR's move-bar strip when the panel's rect is odd. See bounds.js.
 * @param {Document} doc - The popup document
 * @returns {{top: number, bottom: number}} Distances from the popup's top and bottom edges in CSS px
 * @example
 * overlayBounds(popup.document) // { top: 0, bottom: 41 } in minimal mode
 */
const overlayBounds = (doc) => {
  const viewportHeight = doc.defaultView?.innerHeight ?? 0;
  try {
    const panel = doc.querySelector('[class*="Layout_"]')?.getBoundingClientRect() ?? null;
    return computeBounds({ viewportHeight, panel });
  } catch {
    return computeBounds({ viewportHeight, panel: null });
  }
};

/**
 * Install the keyboard and expose window.__fjk.
 * @returns {object} The public handle (also window.__fjk)
 * @example
 * install()
 */
const install = () => {
  const settings = loadSettings();
  const pages = createKeyboardState(settings.mode);
  const shift = createShift();
  const direct = createComposer(() => settings);
  const compose = createComposer(() => settings);
  const output = createOutput();
  /** @type {import('./composer.js').OutputOp[]|null} Debug capture: when set, output goes here instead of Steam. */
  let captured = null;

  /**
   * Deliver operations to the target (or to the debug capture).
   * @param {import('./composer.js').OutputOp[]} ops - Operations
   * @returns {boolean} False when nothing could be sent
   * @example
   * send([{ text: 'あ' }])
   */
  const send = (ops) => {
    tracker.observe(ops);
    if (captured) {
      captured.push(...ops);
      return true;
    }
    return output(ops);
  };

  /** Follows the word being typed, for English suggestions and auto-capitalization. */
  const tracker = createWordTracker();
  /** @type {import('./english.js').Dictionary|null} */
  let dictionary = null;
  /** @type {import('./english.js').Suggestion[]} */
  let suggestions = [];
  /** @type {string[]} Candidates as last drawn, so a tap commits exactly what the user saw. */
  let shownCandidates = [];

  /**
   * The English dictionary, decoded on first use (~20 ms for 40,000 words).
   * @returns {import('./english.js').Dictionary} Dictionary
   * @example
   * getDictionary().byLower.size
   */
  const getDictionary = () => {
    dictionary ??= createDictionary(decodeWords(WORDS_EN));
    return dictionary;
  };

  /**
   * Whether the next letter should be capitalized automatically (sentence start, shift off).
   * @returns {boolean} True when auto-capitalization applies
   * @example
   * autoCapital()
   */
  const autoCapital = () => settings.autoCapitalize && pages.page === 'qwerty' && shift.state === 'off' && tracker.sentenceStart;

  /**
   * Whether a sentence starts here (auto-capitalization on, QWERTY page), ignoring shift.
   * @returns {boolean} True at a sentence start
   * @example
   * sentenceStartHere()
   */
  const sentenceStartHere = () => settings.autoCapitalize && pages.page === 'qwerty' && tracker.sentenceStart;

  /**
   * Suggestions for the current English word (QWERTY and number pages only).
   * @returns {import('./english.js').Suggestion[]} Suggestions
   * @example
   * currentSuggestions()
   */
  const currentSuggestions = () => {
    if (!settings.suggestions || !['qwerty', 'num', 'num2'].includes(pages.page) || !tracker.word) return [];
    return suggest(getDictionary(), tracker.word);
  };

  /** @type {ReturnType<typeof mountOverlay>|null} */
  let overlay = null;
  /** @type {Document|null} */
  let overlayDoc = null;
  /** @type {{VRKeyboardStatus: {bIsOpen: boolean, bMinimal: boolean}}|null} */
  let statusStore = null;
  let wasOpen = false;
  let tickTimer;
  let prereqTimer;
  let renderQueued = false;

  /**
   * Redraw the overlay (coalesced to once per microtask).
   * @returns {void}
   * @example
   * scheduleRender()
   */
  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      try {
        suggestions = currentSuggestions();
        const view = ime.view();
        shownCandidates = view.candidates;
        const shiftShown = autoCapital() ? 'once' : shift.state;
        overlay?.render({ page: pages.page, mode: pages.mode, shift: shiftShown, view, suggestions });
      } catch (error) {
        warn('render failed', error);
      }
    });
  };

  const ime = createIme({
    engine: null,
    direct,
    compose,
    send,
    onChange: scheduleRender,
    warn,
    liveDelayMs: settings.liveDelayMs,
    predictions: settings.predictions,
  });

  /** @type {ReturnType<typeof createIBusEngine>|null} */
  let engine = null;
  if (settings.conversion) {
    engine = createIBusEngine({ onCommit: (text) => ime.handleCommit(text), onUpdate: () => ime.handleUpdate() });
    engine.init().then((ok) => {
      if (ok && api.state !== 'uninstalled') ime.attachEngine(engine);
      else if (!ok) warn('IBus/anthy unavailable; falling back to direct hiragana input');
    });
  } else {
    log('conversion disabled in settings; typing hiragana directly');
  }

  /**
   * Turn our overlay on (our keyboard) or off (stock Steam keyboard with a small re-enable button).
   * Turning it off hands IBus back to the stock keyboard.
   * @param {boolean} value - Enabled state
   * @returns {void}
   * @example
   * setEnabled(false)
   */
  const setEnabled = (value) => {
    settings.enabled = !!value;
    saveSettings(settings);
    if (!settings.enabled) ime.release();
    overlay?.setEnabled(settings.enabled);
    scheduleRender();
    log(settings.enabled ? 'overlay enabled' : 'overlay disabled (stock keyboard)');
  };

  /**
   * Switch between our kana and QWERTY keyboards, committing any composition first.
   * @returns {void}
   * @example
   * toggleMode()
   */
  const toggleMode = () => {
    ime.commitAll();
    shift.reset();
    settings.mode = pages.toggleMode();
    saveSettings(settings);
  };

  /**
   * Handle an action key.
   * @param {string} id - Action id from the layout
   * @returns {void}
   * @example
   * handleAction('backspace')
   */
  const handleAction = (id) => {
    switch (id) {
      case 'undo': ime.undo(); break;
      case 'backspace': ime.backspace(); break;
      case 'left': ime.arrow('left'); break;
      case 'right': ime.arrow('right'); break;
      case 'space': ime.space(); break;
      case 'enter': ime.enter(); break;
      case 'modify': ime.modify(); break;
      case 'mode': toggleMode(); break;
      case 'shift': shift.tap(); break;
      case 'symbols': pages.show('sym1'); break;
      case 'sym1':
      case 'sym2':
      case 'num':
      case 'num2':
      case 'qwerty':
        pages.show(id);
        break;
      case 'back': pages.back(); break;
      case 'stock':
        ime.commitAll();
        setEnabled(false);
        break;
      default: warn('unknown action', id);
    }
    scheduleRender();
  };

  /**
   * Handle a character key (QWERTY letters, numbers, symbols).
   * @param {import('./layout.js').KeyDef} def - Key definition
   * @param {string} direction - "center" or "up"
   * @returns {void}
   * @example
   * handleChar(def, 'up')
   */
  const handleChar = (def, direction) => {
    if (direction === 'up' && def.up) {
      ime.text(def.up).then(scheduleRender);
    } else if (def.letter) {
      // Shift is the user's choice at tap time; auto-capitalization is decided when the letter is
      // sent, after everything typed before it (e.g. ". ") has been seen by the tracker.
      const shifted = shift.state !== 'off';
      const ch = shift.apply(def.ch);
      ime.text(() => (!shifted && sentenceStartHere() ? ch.toUpperCase() : ch)).then(scheduleRender);
    } else {
      ime.text(def.ch).then(scheduleRender);
    }
    scheduleRender();
  };

  /**
   * Enter a tapped English suggestion: replace the current word (as sent so far) and add a space.
   * @param {number} index - Index in the suggestion strip
   * @returns {Promise<void>} Resolves when sent
   * @example
   * pickSuggestion(0)
   */
  const pickSuggestion = (index) => {
    const picked = suggestions[index];
    if (!picked) return Promise.resolve();
    shift.reset();
    return ime.replaceTail(() => Array.from(tracker.word).length, `${picked.text} `).then(scheduleRender);
  };

  /**
   * Periodic check: keep the overlay mounted in the current popup and follow open/close.
   * @returns {void}
   * @example
   * tick()
   */
  const tick = () => {
    try {
      const win = getKeyboardPopupWindow();
      const doc = win?.document ?? null;
      if (overlay && (doc !== overlayDoc || !overlay.host.isConnected)) {
        overlay.destroy();
        overlay = null;
        overlayDoc = null;
        log('keyboard popup changed; overlay removed');
      }
      if (!overlay && doc?.body) {
        overlay = mountOverlay(doc, {
          getSettings: () => settings,
          onKana: (keyId, direction) => ime.kana(keyId, direction),
          onChar: handleChar,
          onAction: handleAction,
          onCandidate: (index) => ime.select(index, shownCandidates[index]),
          onSuggestion: pickSuggestion,
          onEnable: () => setEnabled(true),
        });
        overlayDoc = doc;
        overlay.setEnabled(settings.enabled);
        scheduleRender();
        log(`overlay mounted in keyboard popup (${win.innerWidth}x${win.innerHeight}, enabled=${settings.enabled}, mode=${pages.mode})`);
      }
      const status = statusStore?.VRKeyboardStatus;
      const open = status ? !!status.bIsOpen : !!doc;
      if (open && !wasOpen) {
        ime.discard();
        tracker.reset();
        overlay?.cancelGesture();
        log(`keyboard opened${status ? ` (${status.bMinimal ? 'minimal' : 'buffered'} mode)` : ''}`);
      } else if (!open && wasOpen) {
        // Nothing composed is sent; IBus goes back to the stock keyboard's state.
        ime.release();
        overlay?.cancelGesture();
        log('keyboard closed');
      }
      wasOpen = open;
      if (overlay && doc) overlay.setBounds(overlayBounds(doc));
    } catch (error) {
      warn('tick failed', error);
    }
  };

  /**
   * Start once Steam's objects exist.
   * @returns {void}
   * @example
   * start()
   */
  const start = () => {
    statusStore = findVRStatusStore(getWebpackRequire());
    if (!statusStore) warn('VRKeyboardStatus store not found; open/close tracking disabled');
    api.state = 'running';
    tickTimer = setInterval(tick, TICK_MS);
    tick();
    log(`installed ${VERSION}`);
  };

  /**
   * Remove everything this instance added and hand IBus back.
   * @returns {void}
   * @example
   * window.__fjk.uninstall()
   */
  const uninstall = () => {
    clearInterval(tickTimer);
    clearInterval(prereqTimer);
    overlay?.destroy();
    overlay = null;
    ime.release().finally(() => engine?.destroy().catch((error) => warn('IBus cleanup failed', error)));
    if (globalThis.__fjk === api) delete globalThis.__fjk;
    api.state = 'uninstalled';
    log(`uninstalled ${VERSION}`);
  };

  /**
   * Wait until queued input has been applied and IBus signals have arrived (debug API).
   * @returns {Promise<{view: import('./ime.js').ImeView, output: import('./composer.js').OutputOp[]|null}>} Current view and captured output
   * @example
   * await drained()
   */
  const drained = async () => {
    await ime.flush();
    await engine?.settle();
    return { view: ime.view(), output: captured ? [...captured] : null };
  };

  /**
   * Run an input method call, then report the resulting view (debug API).
   * @param {Promise<void>} done - The call's promise
   * @returns {Promise<{view: import('./ime.js').ImeView, output: import('./composer.js').OutputOp[]|null}>} Result
   * @example
   * await step(ime.space())
   */
  const step = async (done) => {
    await done;
    scheduleRender();
    return drained();
  };

  // Test hooks for driving the input method without a headset. Call debug.capture(true) first so
  // committed text is collected in debug.output instead of being typed into whatever has focus.
  const debug = {
    /**
     * Collect output instead of sending it to Steam.
     * @param {boolean} on - Capture on/off
     * @returns {boolean} The capture state
     * @example
     * __fjk.debug.capture(true)
     */
    capture: (on) => {
      captured = on ? [] : null;
      return !!captured;
    },
    /**
     * Type kana into the composition (same path as the flick keys).
     * @param {string} text - Kana
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.type('かんじ')
     */
    type: (text) => step(ime.kanaText(text)),
    /**
     * Press a kana key.
     * @param {string} keyId - Kana key id
     * @param {string} [direction='center'] - Flick direction
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.flick('ka', 'left')
     */
    flick: (keyId, direction = 'center') => step(ime.kana(keyId, direction)),
    /**
     * Press an action key by id (space, enter, backspace, undo, modify, left, right, mode, ...).
     * @param {string} id - Action id
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.key('space')
     */
    key: (id) => {
      handleAction(id);
      return step(Promise.resolve());
    },
    /**
     * Pick a candidate.
     * @param {number} index - Candidate index
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.select(1)
     */
    select: (index) => step(ime.select(index)),
    /**
     * Type literal text (like a QWERTY or symbol key).
     * @param {string} text - Text
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.text('A')
     */
    text: (text) => step(ime.text(text)),
    /**
     * Release IBus as when the keyboard closes.
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.release()
     */
    release: () => step(ime.release()),
    /**
     * Measure the overlay geometry of a page. The page is shown, measured and restored within one
     * task, so nothing visible changes (works while the overlay is disabled, too).
     * @param {import('./keyboard-state.js').PageId} [page='kana'] - Page to measure
     * @returns {object|null} Rects in popup CSS px, or null when no overlay is mounted
     * @example
     * __fjk.debug.measure('kana').pad
     */
    measure: (page = 'kana') => {
      if (!overlay) return null;
      /**
       * Render the overlay with a page.
       * @param {import('./keyboard-state.js').PageId} id - Page
       * @returns {void}
       * @example
       * show('kana')
       */
      const show = (id) => overlay.render({ page: id, mode: pages.mode, shift: shift.state, view: ime.view() });
      overlay.setEnabled(true);
      show(page);
      const result = overlay.measure();
      overlay.setEnabled(settings.enabled);
      show(pages.page);
      return result;
    },
    /**
     * Type English text through the QWERTY keys (letters honour shift and auto-capitalization;
     * an upper-case letter in the input presses shift first).
     * @param {string} text - Text
     * @returns {Promise<object>} English state and captured output
     * @example
     * await __fjk.debug.english('helo')
     */
    english: async (text) => {
      for (const c of Array.from(text)) {
        const letter = /^[a-z]$/i.test(c);
        if (letter && c !== c.toLowerCase() && !autoCapital() && shift.state === 'off') shift.tap();
        handleChar({ type: 'char', id: c, ch: letter ? c.toLowerCase() : c, label: c, w: 1, letter }, 'center');
      }
      await ime.flush();
      return { word: tracker.word, sentenceStart: tracker.sentenceStart, autoCapital: autoCapital(), suggestions: currentSuggestions(), output: captured ? [...captured] : null };
    },
    /**
     * Tap an English suggestion.
     * @param {number} index - Index in the strip
     * @returns {Promise<object>} English state and captured output
     * @example
     * await __fjk.debug.suggestion(0)
     */
    suggestion: async (index) => {
      suggestions = currentSuggestions();
      await pickSuggestion(index);
      return { word: tracker.word, output: captured ? [...captured] : null };
    },
    /**
     * Show a page (like tapping あA / 123 / ☺記), for tests.
     * @param {import('./keyboard-state.js').PageId} page - Page
     * @returns {string} The page shown
     * @example
     * __fjk.debug.page('qwerty')
     */
    page: (page) => {
      const shown = pages.show(page);
      scheduleRender();
      return shown;
    },
    /**
     * Live-candidate info and timings (reading, items, query ms, key wait ms).
     * @returns {object} Info
     * @example
     * __fjk.debug.live().lastMs
     */
    live: () => ime.liveInfo(),
    /**
     * Current state for inspection.
     * @returns {object} State
     * @example
     * __fjk.debug.state()
     */
    state: () => ({
      view: ime.view(),
      page: pages.page,
      mode: pages.mode,
      shift: shift.state,
      engine: engine?.info ?? null,
      engineState: engine ? { ...engine.state } : null,
      output: captured ? [...captured] : null,
    }),
  };

  const api = {
    version: VERSION,
    state: 'waiting',
    get enabled() {
      return settings.enabled;
    },
    setEnabled,
    settings,
    uninstall,
    debug,
  };
  globalThis.__fjk = api;

  const startedAt = Date.now();
  /**
   * Wait for Steam's objects; give up (and stay inert) after a timeout.
   * @returns {boolean} Whether waiting is over
   * @example
   * checkPrerequisites()
   */
  const checkPrerequisites = () => {
    const missing = missingPrerequisites();
    if (missing.length === 0) {
      start();
      return true;
    }
    if (Date.now() - startedAt > PREREQ_TIMEOUT_MS) {
      api.state = 'failed';
      warn(`giving up, stock keyboard left untouched; missing: ${missing.join(', ')}`);
      return true;
    }
    return false;
  };
  if (!checkPrerequisites()) {
    log(`waiting for Steam UI (${missingPrerequisites().join(', ')})`);
    prereqTimer = setInterval(() => {
      if (checkPrerequisites()) clearInterval(prereqTimer);
    }, PREREQ_POLL_MS);
  }
  return api;
};

/**
 * Tear down a previous instance (re-injection during development), then install.
 * @returns {void}
 * @example
 * main()
 */
const main = () => {
  const previous = globalThis.__fjk;
  if (previous && typeof previous.uninstall === 'function') {
    try {
      previous.uninstall();
    } catch (error) {
      warn('previous instance failed to uninstall', error);
    }
  }
  delete globalThis.__fjk;
  try {
    install();
  } catch (error) {
    warn('install failed; stock keyboard left untouched', error);
    // Leave an inert handle so the injector does not re-inject in a loop.
    globalThis.__fjk = { version: VERSION, state: 'failed', enabled: false, uninstall: inertUninstall };
  }
};

/**
 * Uninstall for the inert handle left after a failed install.
 * @returns {void}
 * @example
 * inertUninstall()
 */
const inertUninstall = () => {
  delete globalThis.__fjk;
};

main();
