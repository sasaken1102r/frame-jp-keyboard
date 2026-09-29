// Entry point, evaluated in Steam's SharedJSContext by the injector.
// Idempotent: a previous instance (window.__fjk) is torn down before the new one installs.
// Fail safe: if Steam's objects are missing we log [fjk] warnings and leave the stock keyboard alone.
import { computeBounds } from './bounds.js';
import { createComposer } from './composer.js';
import { WORDS_EN } from './data/words-en.js';
import { createDictionary, createWordTracker, decodeWords, suggest } from './english.js';
import { createEnglishComposition, isWordChar } from './english-compose.js';
import { createAnthyClient } from './anthy-client.js';
import { installApiRecorder } from './api-recorder.js';
import { createIme } from './ime.js';
import { CLIPBOARD_CHORDS, createModifiers, keyForChar, keyForName, planChord } from './key-chords.js';
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
  getKeyboardManagers,
  isOurCall,
  releaseHeldKeys,
} from './steam.js';
import { createUpdater } from './update.js';
import { mountOverlay } from './ui.js';

/* global __FJK_VERSION__ */
const VERSION = typeof __FJK_VERSION__ === 'string' ? __FJK_VERSION__ : 'dev';
// Set by the injector right before it evaluates this bundle (see frame_jp_keyboard_injector.py's
// inject()): Steam's language (~/.steam/registry.vdf, like the other Frame apps), since this
// keyboard has no language setting of its own.
const LANG = globalThis.__fjkLang === 'en' ? 'en' : 'ja';
/** Popup and open/close check. Short, so an English word is committed soon after a close. */
const TICK_MS = 150;
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
  /** One-shot Ctrl / Alt of the QWERTY and number pages (key-chords.js). */
  const modifiers = createModifiers();
  const direct = createComposer(() => settings);
  const compose = createComposer(() => settings);
  const output = createOutput(() => {
    const status = statusStore?.VRKeyboardStatus;
    return { buffered: !!status?.bIsOpen && !status.bMinimal, vrStatus: status };
  });
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

  /** Follows the text sent to the target (for auto-capitalization after ". "). */
  const tracker = createWordTracker();
  /** The English word being typed on the QWERTY keyboard, shown in the composition line. */
  const english = createEnglishComposition();
  /** @type {import('./english.js').Dictionary|null} */
  let dictionary = null;
  /** @type {import('./english.js').Suggestion[]} */
  let suggestions = [];
  /** @type {string[]} Candidates as last drawn, so a tap commits exactly what the user saw. */
  let shownCandidates = [];

  /**
   * A tap on a candidate in the left panel (the UI and the debug API use this same path).
   * @param {number} index - Index of the candidate as drawn
   * @returns {Promise<void>} Resolves when applied
   * @example
   * tapCandidate(0)
   */
  const tapCandidate = (index) => ime.select(index, shownCandidates[index]);

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
  const autoCapital = () => settings.autoCapitalize && pages.page === 'qwerty' && shift.state === 'off' && !english.word && tracker.sentenceStart;

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
    if (!settings.suggestions || !englishPage() || !english.word) return [];
    // The word itself is shown in the composition line, so the "typed" entry is left out.
    return suggest(getDictionary(), english.word).filter((s) => s.kind !== 'typed');
  };

  /**
   * Whether an English page is shown (the composition line belongs to these pages).
   * @returns {boolean} True for QWERTY and the number pages
   * @example
   * englishPage()
   */
  const englishPage = () => ['qwerty', 'num', 'num2'].includes(pages.page);

  /**
   * Commit the English word (with a suffix such as a space or punctuation) to the target, through
   * the same output path as everything else.
   * @param {string} [suffix=''] - Text after the word
   * @returns {Promise<void>} Resolves when sent
   * @example
   * commitEnglish(' ')
   */
  const commitEnglish = (suffix = '') => {
    const ops = english.commit(suffix);
    scheduleRender();
    return ops.length ? ime.text(ops[0].text).then(scheduleRender) : Promise.resolve();
  };

  /** @type {ReturnType<typeof mountOverlay>|null} */
  let overlay = null;
  /** @type {Document|null} */
  let overlayDoc = null;
  /** @type {{VRKeyboardStatus: {bIsOpen: boolean, bMinimal: boolean}}|null} */
  let statusStore = null;
  let wasOpen = false;
  let tickTimer;
  /**
   * Diagnostics (settings.debugRecorders, off by default; read once per injection): raw input around
   * each press, key gestures, calls into Steam's keyboard API and VR keyboard state changes, all
   * without text. Only then are any Steam functions wrapped (api-recorder.js).
   */
  const diagnostics = settings.debugRecorders === true;
  /** @type {ReturnType<typeof installApiRecorder>|null} */
  let apiRecorder = null;
  /** Last logged VR keyboard state (diagnostics). */
  let lastVrState = '';
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
        const shiftShown = autoCapital() && !modifiers.active ? 'once' : shift.state;
        overlay?.render({
          page: pages.page, mode: pages.mode, shift: shiftShown, view, suggestions,
          english: { text: english.word, caret: english.caret }, update: updater.view,
          modifiers: { ctrl: modifiers.ctrl, alt: modifiers.alt },
        });
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

  /** Kana-kanji conversion served by the injector (libanthy); no IBus is involved. */
  /** @type {ReturnType<typeof createAnthyClient>|null} */
  let engine = null;
  if (settings.conversion) {
    engine = createAnthyClient({ warn });
    engine.init().then((ok) => {
      if (ok && api.state !== 'uninstalled') {
        ime.attachEngine(engine);
        log('conversion ready (libanthy via the injector)');
      } else if (!ok) {
        warn('conversion backend unavailable (injector too old or libanthy missing); typing hiragana directly');
      }
    });
  } else {
    log('conversion disabled in settings; typing hiragana directly');
  }

  /**
   * Ask the injector to do something (forced check, install) over its CDP bridge. The injector adds
   * this global with Runtime.addBinding; it may be missing on an older injector (fails safe: the
   * indicator just never hears back, same as any other unreachable-CDP case).
   * @param {{action: 'check'|'install'}} message - Request
   * @returns {void}
   * @example
   * bridgeSend({ action: 'check' })
   */
  const bridgeSend = (message) => {
    try {
      if (typeof globalThis.fjkUpdateBridge === 'function') globalThis.fjkUpdateBridge(JSON.stringify(message));
      else warn('update bridge unavailable (injector too old?)');
    } catch (error) {
      warn('update bridge send failed', error);
    }
  };
  const updater = createUpdater({ lang: LANG, send: bridgeSend, onChange: scheduleRender, warn });

  /**
   * Turn our overlay on (our keyboard) or off (stock Steam keyboard with a small re-enable button).
   * Turning it off commits the English word and drops the kana composition.
   * @param {boolean} value - Enabled state
   * @returns {void}
   * @example
   * setEnabled(false)
   */
  const setEnabled = (value) => {
    settings.enabled = !!value;
    saveSettings(settings);
    if (!settings.enabled) {
      commitEnglish();
      ime.release();
      modifiers.clear();
    }
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
    commitEnglish();
    ime.commitAll();
    shift.reset();
    modifiers.clear();
    settings.mode = pages.toggleMode();
    saveSettings(settings);
  };

  /**
   * Actions that behave differently while an English word is composed (and ↑ / ↓, which only
   * exist on the English pages).
   * @param {string} id - Action id
   * @returns {boolean} True when handled here
   * @example
   * handleEnglishAction('space')
   */
  const handleEnglishAction = (id) => {
    const composing = english.word.length > 0;
    switch (id) {
      case 'backspace': {
        const ops = english.backspace();
        if (ops.length) ime.backspace();
        return true;
      }
      case 'left':
      case 'right': {
        const ops = english.arrow(id);
        if (ops.length) ime.arrow(id);
        return true;
      }
      case 'space':
        if (!composing) return false;
        commitEnglish(' ');
        return true;
      case 'enter':
        if (!composing) return false;
        commitEnglish();
        return true;
      case 'up':
      case 'down':
        // ↑ / ↓ (← / → flicked up): the word is committed first, then the key goes out like ← / →.
        commitEnglish().then(() => send([{ key: id === 'up' ? 'ArrowUp' : 'ArrowDown' }]));
        return true;
      default:
        return false;
    }
  };

  /**
   * The close button: commit whatever is being typed (through the normal output), then close
   * the keyboard with the key the stock keyboard uses: VKDone when the popup asks for a Done key,
   * otherwise VKClose (VirtualKeyboardManager.HandleVirtualKeyDown hides the keyboard for both).
   * @returns {Promise<void>} Resolves when the close key has been queued
   * @example
   * closeKeyboard()
   */
  const closeKeyboard = () => {
    commitEnglish();
    const key = statusStore?.VRKeyboardStatus?.bShowDoneKey ? 'VKDone' : 'VKClose';
    return ime.commitAll().then(() => {
      send([{ key }]);
    });
  };

  /**
   * Send one key chord (see key-chords.js) after everything typed so far has been committed, so the
   * chord acts on the text as the user sees it.
   * @param {{ctrl?: boolean, alt?: boolean, shift?: boolean}} held - Modifiers to hold
   * @param {{code: number, shift: boolean}} key - The key
   * @returns {Promise<void>} Resolves when the chord is queued
   * @example
   * sendChord({ ctrl: true }, keyForChar('c'))
   */
  const sendChord = (held, key) => commitEnglish()
    .then(() => ime.commitAll())
    .then(() => {
      send([{ keys: planChord(held, key) }]);
    })
    .catch((error) => warn('key chord failed', error));

  /**
   * Take the modifiers for the next chord: the armed Ctrl / Alt (disarmed now) and a lit Shift (a
   * one-shot Shift is used up, a locked one stays).
   * @returns {{ctrl: boolean, alt: boolean, shift: boolean}} Modifiers to hold
   * @example
   * takeHeld()
   */
  const takeHeld = () => {
    const held = { ...modifiers.take(), shift: shift.state !== 'off' };
    if (shift.state === 'once') shift.reset();
    return held;
  };

  /** Action keys that go out as a key (with the armed Ctrl / Alt) instead of their usual meaning. */
  const CHORD_ACTIONS = Object.freeze({
    backspace: 'Backspace', enter: 'Enter', space: 'Space', left: 'ArrowLeft', right: 'ArrowRight',
    up: 'ArrowUp', down: 'ArrowDown',
  });
  /** Arrow actions (← / → and their up-flicks ↑ / ↓). */
  const ARROWS = Object.freeze(['left', 'right', 'up', 'down']);

  /**
   * Esc, Ctrl, Alt, the clipboard buttons, and other keys while Ctrl / Alt is armed.
   * @param {string} id - Action id
   * @returns {boolean} True when handled here
   * @example
   * handleChordAction('copy')
   */
  const handleChordAction = (id) => {
    switch (id) {
      case 'ctrl':
      case 'alt':
        modifiers.toggle(id);
        return true;
      case 'esc':
        // Esc first drops an English word being typed; otherwise it goes to the target.
        if (english.word) {
          english.cancel();
          modifiers.clear();
        } else {
          sendChord(takeHeld(), keyForName('Escape'));
        }
        return true;
      case 'tab':
        // Tab always goes out as a key press (with a lit Ctrl / Alt / Shift), after the word.
        sendChord(takeHeld(), keyForName('Tab'));
        return true;
      case 'cut':
      case 'copy':
      case 'paste':
        modifiers.clear();
        sendChord({ ctrl: true }, keyForChar(CLIPBOARD_CHORDS[id]));
        return true;
      default: {
        if (!Object.hasOwn(CHORD_ACTIONS, id)) return false;
        // A lit Shift alone makes the arrows select (Shift+←), as on a PC; not inside a word, where
        // ← / → move within the word.
        const shiftArrow = englishPage() && ARROWS.includes(id) && shift.state !== 'off' && !english.word;
        if (!modifiers.active && !shiftArrow) return false;
        sendChord(takeHeld(), keyForName(CHORD_ACTIONS[id]));
        return true;
      }
    }
  };

  /**
   * Handle an action key.
   * @param {string} id - Action id from the layout
   * @returns {void}
   * @example
   * handleAction('backspace')
   */
  const handleAction = (id) => {
    if (handleChordAction(id)) {
      scheduleRender();
      return;
    }
    // Ctrl and Alt only live on the QWERTY and number pages.
    if (['mode', 'symbols', 'sym1', 'sym2', 'back', 'close', 'stock'].includes(id)) modifiers.clear();
    if (englishPage() && handleEnglishAction(id)) {
      scheduleRender();
      return;
    }
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
      case 'close':
        closeKeyboard();
        break;
      case 'stock':
        commitEnglish();
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
    if (englishPage() && modifiers.active) {
      // With Ctrl / Alt armed the key goes out as a chord, past the word, suggestions and
      // auto-capitalization. Shift (tap or lock) is part of the chord too.
      const ch = direction === 'up' && def.up ? def.up : def.ch;
      const key = keyForChar(ch);
      if (key) {
        sendChord(takeHeld(), key);
        scheduleRender();
        return;
      }
      // No key types this character (e.g. €): disarm and type it as usual.
      modifiers.clear();
      log('ctrl/alt: this character has no key; typed as text');
    }
    if (englishPage()) {
      const flicked = direction === 'up' && def.up;
      if (def.letter && !flicked) {
        // Auto-capitalize the first letter of a word at a sentence start (shift off).
        const shifted = shift.state !== 'off';
        const ch = shift.apply(def.ch);
        english.input(!shifted && !english.word && sentenceStartHere() ? ch.toUpperCase() : ch);
      } else {
        const ch = flicked ? def.up : def.ch;
        // Letters stay in the word; punctuation, symbols and digits commit it followed by themselves.
        if (isWordChar(ch)) english.input(ch);
        else commitEnglish(ch);
      }
      scheduleRender();
      return;
    }
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
    shift.reset();
    if (index === -1) return commitEnglish(' ');
    const picked = suggestions[index];
    if (!picked) return Promise.resolve();
    const ops = english.commitAs(picked.text, ' ');
    scheduleRender();
    return ime.text(ops[0].text).then(scheduleRender);
  };

  /**
   * Periodic check: keep the overlay mounted in the current popup and follow open/close.
   * @returns {void}
   * @example
   * tick()
   */
  const tick = () => {
    try {
      apiRecorder?.refresh();
      const win = getKeyboardPopupWindow();
      const doc = win?.document ?? null;
      if (overlay && (doc !== overlayDoc || !overlay.host.isConnected)) {
        commitEnglish();
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
          onCandidate: tapCandidate,
          onSuggestion: pickSuggestion,
          onEnable: () => setEnabled(true),
          onRecord: diagnostics ? (w) => log(`rec ${JSON.stringify(w)}`) : undefined,
          onGesture: diagnostics ? (record) => log(`gesture ${JSON.stringify(record)}`) : undefined,
          onUpdateTap: () => updater.tapIndicator(),
          onUpdateAction: (action) => {
            if (action === 'yes') updater.tapConfirmYes();
            else if (action === 'no') updater.tapConfirmNo();
            else updater.tapDismiss();
          },
        });
        overlayDoc = doc;
        overlay.setEnabled(settings.enabled);
        scheduleRender();
        log(`overlay mounted in keyboard popup (${win.innerWidth}x${win.innerHeight}, enabled=${settings.enabled}, mode=${pages.mode})`);
      }
      const status = statusStore?.VRKeyboardStatus;
      const open = status ? !!status.bIsOpen : !!doc;
      if (diagnostics) {
        // Every change of the VR keyboard's state, whoever's keyboard is shown.
        const vrState = status ? `open=${!!status.bIsOpen} mode=${status.bMinimal ? 'minimal' : 'buffered'} target=${status.sOverlayKey || '-'} app=${status.unAppID} dispatch=${!!status.bDispatchEventsToSteamVR}` : 'no status';
        const state = `${vrState} popup=${doc ? 'yes' : 'no'} ours=${settings.enabled ? 'on' : 'off'}`;
        if (state !== lastVrState) log(`vr keyboard: ${state}`);
        lastVrState = state;
      }
      if (open && !wasOpen) {
        // An English word left over (a close we did not see) stays composed on screen: it is neither
        // sent to the new target nor thrown away; the user commits or deletes it.
        ime.discard();
        tracker.reset();
        overlay?.cancelGesture();
        log(`keyboard opened${status ? ` (${status.bMinimal ? 'minimal' : 'buffered'} mode)` : ''}`);
      } else if (!open && wasOpen) {
        // The English word is committed (best effort: we notice the close after it happened);
        // the kana composition is discarded as before.
        commitEnglish();
        ime.release();
        modifiers.clear();
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
   * State that decides where a HandleVirtualKeyDown call goes, for the debug recorder (no text).
   * @param {string} label - Recorded method
   * @param {any} target - The object called (a VirtualKeyboardManager for VKM methods)
   * @param {unknown[]} args - Call arguments
   * @returns {object|undefined} Extra log fields
   * @example
   * apiCallState('VKM0.HandleVirtualKeyDown', manager, ['Enter', false])
   */
  const apiCallState = (label, target, args) => {
    if (!label.endsWith('.HandleVirtualKeyDown')) return undefined;
    const status = statusStore?.VRKeyboardStatus;
    const state = {
      override: typeof target?.m_fnVROnTextEnteredOverride === 'function',
      mode: status ? (status.bIsOpen ? (status.bMinimal ? 'minimal' : 'buffered') : 'closed') : '?',
      fjk: settings.enabled && !!overlay,
    };
    if (args[0] !== 'Enter') return state;
    const onEnter = target?.m_ActiveElementProps?.onEnterKeyPress;
    return {
      ...state,
      onEnter: onEnter === undefined ? 'none' : typeof onEnter,
      dismissOnEnter: !!target?.m_bDismissOnEnter,
      target: status?.sOverlayKey || null,
      dispatchVR: status ? !!status.bDispatchEventsToSteamVR : null,
    };
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
    if (diagnostics) {
      try {
        apiRecorder = installApiRecorder({
          getManagers: getKeyboardManagers,
          isOurs: isOurCall,
          onCall: (entry) => log(`vk ${JSON.stringify(entry)}`),
          extra: apiCallState,
        });
        log(`debug recorders on (${apiRecorder.count} Steam methods wrapped)`);
      } catch (error) {
        warn('api recorder failed', error);
      }
    }
    tickTimer = setInterval(tick, TICK_MS);
    tick();
    log(`installed ${VERSION}`);
  };

  /**
   * Remove everything this instance added.
   * @returns {void}
   * @example
   * window.__fjk.uninstall()
   */
  const uninstall = () => {
    clearInterval(tickTimer);
    clearInterval(prereqTimer);
    apiRecorder?.uninstall();
    apiRecorder = null;
    commitEnglish(); // never drop a word being typed (e.g. when a new build is injected)
    modifiers.clear();
    releaseHeldKeys(); // nothing should be held, but never leave a key pressed in the OS
    overlay?.destroy();
    overlay = null;
    ime.release().finally(() => engine?.destroy());
    if (globalThis.__fjk === api) delete globalThis.__fjk;
    api.state = 'uninstalled';
    log(`uninstalled ${VERSION}`);
  };

  /**
   * Wait until queued input has been applied and live candidates have arrived (debug API).
   * @returns {Promise<{view: import('./ime.js').ImeView, output: import('./composer.js').OutputOp[]|null}>} Current view and captured output
   * @example
   * await drained()
   */
  const drained = async () => {
    await ime.flush();
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
     * Turn the diagnostic recorders on or off (saved; takes effect on the next injection).
     * @param {boolean} on - Recorders on/off
     * @returns {boolean} The saved setting
     * @example
     * __fjk.debug.recorders(true)
     */
    recorders: (on) => {
      settings.debugRecorders = !!on;
      saveSettings(settings);
      return settings.debugRecorders;
    },
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
     * Pick a candidate by its index in the panel (throws for an index that is not shown).
     * @param {number} index - Candidate index
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.select(1)
     */
    select: (index) => {
      const shown = ime.view().candidates;
      if (!Number.isInteger(index) || index < 0 || index >= shown.length) {
        throw new RangeError(`no candidate at index ${index} (${shown.length} shown)`);
      }
      return step(ime.select(index, shown[index]));
    },
    /**
     * Tap the candidate with this text, exactly as the UI does (index as drawn in the panel).
     * @param {string} text - Candidate text as shown
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.tap('今日はいい天気')
     */
    tap: (text) => {
      scheduleRender();
      const index = ime.view().candidates.indexOf(text);
      if (index < 0) throw new RangeError(`candidate not shown: ${text}`);
      shownCandidates = ime.view().candidates;
      return step(tapCandidate(index));
    },
    /**
     * Type literal text (like a QWERTY or symbol key).
     * @param {string} text - Text
     * @returns {Promise<object>} View and captured output
     * @example
     * await __fjk.debug.text('A')
     */
    text: (text) => step(ime.text(text)),
    /**
     * Drop the composition as when the keyboard closes.
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
      return { composing: english.word, sentenceStart: tracker.sentenceStart, autoCapital: autoCapital(), suggestions: currentSuggestions(), output: captured ? [...captured] : null };
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
      return { composing: english.word, output: captured ? [...captured] : null };
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
     * Press a kana key and measure how long until the panel draws it (local echo), and until anthy
     * has the strokes. Frames are counted with the popup's requestAnimationFrame.
     * @param {string} keyId - Kana key id
     * @param {string} [direction='center'] - Flick direction
     * @returns {Promise<{sameTask: boolean, domMs: number, drawnMs: number, frames: number, anthyMs: number}>} Timings
     * @example
     * await __fjk.debug.echo('ka')
     */
    echo: async (keyId, direction = 'center') => {
      const win = overlayDoc?.defaultView;
      const before = overlay?.preeditText() ?? '';
      const t0 = performance.now();
      const task = ime.kana(keyId, direction);
      // Our render runs as a microtask after the edit: check the DOM before any timer or frame.
      await Promise.resolve();
      await Promise.resolve();
      const sameTask = overlay ? overlay.preeditText() !== before : false;
      const domMs = performance.now() - t0;
      let frames = 0;
      while (overlay && overlay.preeditText() === before && frames < 120) {
        await Promise.race([
          new Promise((resolve) => win?.requestAnimationFrame(resolve)),
          new Promise((resolve) => setTimeout(resolve, 20)),
        ]);
        frames += 1;
      }
      const drawnMs = performance.now() - t0;
      await task;
      return { sameTask, domMs: Math.round(domMs * 10) / 10, drawnMs: Math.round(drawnMs * 10) / 10, frames, anthyMs: Math.round(performance.now() - t0) };
    },
    /**
     * Measure the round trip page -> injector (libanthy) -> page with conversions and predictions
     * only (nothing is typed or committed, so anthy learns nothing).
     * @param {number} [count=12] - Number of requests
     * @returns {Promise<object>} Round-trip times in ms
     * @example
     * await __fjk.debug.anthyLatency()
     */
    anthyLatency: async (count = 12) => {
      if (!engine) return { error: 'no backend' };
      const readings = ['かんじ', 'きょうはいいてんき', 'にほんご', 'でんしゃ'];
      const convert = [];
      const predict = [];
      for (let i = 0; i < count; i += 1) {
        const reading = readings[i % readings.length];
        let t0 = performance.now();
        await engine.convert(reading);
        convert.push(Math.round((performance.now() - t0) * 10) / 10);
        t0 = performance.now();
        await engine.predict(reading);
        predict.push(Math.round((performance.now() - t0) * 10) / 10);
      }
      /**
       * Median of a list.
       * @param {number[]} xs - Values
       * @returns {number} Median
       * @example
       * median([3, 1, 2]) // 2
       */
      const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
      return { convertMs: { median: median(convert), max: Math.max(...convert) }, predictMs: { median: median(predict), max: Math.max(...predict) }, convert, predict };
    },
    /**
     * Laser cursors and recent key gestures (numbers only).
     * @returns {object|null} Info, or null when no overlay is mounted
     * @example
     * __fjk.debug.gestures().gestures.at(-1)
     */
    gestures: () => overlay?.gestures() ?? null,
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
    updater, // the injector calls updater.receive(message) here (see bridgeSend and update.js)
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
