// Input method controller: what each key does while idle, composing kana, or converting.
//
// States
//   idle        nothing composed; keys go straight to the target through the direct composer
//   composing   kana typed but not converted: the reading lives here (mirror.js), shown at once
//   converting  after 変換 or a candidate tap: segments with candidates from the conversion backend
//
// The backend (anthy-client.js: libanthy in the injector) answers self-contained requests in a few
// milliseconds, so there are no key strokes to keep in sync and no preview to abort: live
// candidates are simply requested for the current reading and dropped if the reading changed.
// Nothing reaches the target until a commit, and every commit of anthy's output is reported back
// so anthy learns it (the stock keyboard learns the same way). Without a backend, kana are typed
// directly as hiragana.
//
// Ordering: edits while composing are applied at once. Anything that has to wait for the backend
// (変換, taps, resizing, commits right after them) runs in a queue, and edits made while such a
// task is pending queue behind it, so a commit always sees the latest reading.
import { createDebouncer, mergeCandidates, toKatakana } from './live.js';
import { mirrorOf, mirrorText, applyOps, EMPTY_MIRROR } from './mirror.js';

/**
 * @typedef {import('./mirror.js').Mirror} Mirror
 * @typedef {import('./composer.js').OutputOp} OutputOp
 * @typedef {import('./live.js').LiveCandidate} LiveCandidate
 * @typedef {import('./anthy-client.js').Segment} Segment
 * @typedef {import('./anthy-client.js').ConversionBackend} ConversionBackend
 * @typedef {ReturnType<typeof import('./composer.js').createComposer>} Composer
 */

/**
 * @typedef {object} ImeView
 * @property {'direct'|'idle'|'composing'|'converting'} phase - Current phase ("direct" = no conversion backend)
 * @property {string} preedit - Text being composed (or the conversion)
 * @property {number} caret - Caret inside the reading while composing
 * @property {number} segStart - Start of the current segment while converting
 * @property {number} segLength - Length of the current segment while converting
 * @property {string[]} candidates - Candidates to show
 * @property {number} selected - Selected candidate index (-1 = none)
 * @property {'live'|'lookup'|'none'} source - Live candidates while composing, the segment's candidates while converting
 * @property {boolean} [stale] - The live candidates belong to an older reading (shown dimmed)
 */

/**
 * @typedef {{reading: string, candidates: string[], sel: number}} ConvSegment
 * @typedef {{reading: string, segments: ConvSegment[], cur: number}} Conversion
 */

/**
 * Length of a string in characters (code points).
 * @param {string} s - String
 * @returns {number} Length
 * @example
 * len('漢字') // 2
 */
const len = (s) => Array.from(s).length;

/**
 * Create the input method controller.
 * @param {object} options - Options
 * @param {ConversionBackend|null} options.engine - Conversion backend, or null for direct hiragana input
 * @param {Composer} options.direct - Composer that types straight into the target
 * @param {Composer} options.compose - Composer for the kana being composed
 * @param {(ops: OutputOp[]) => void} options.send - Delivers operations to the target
 * @param {() => void} [options.onChange] - Called when the view may have changed
 * @param {(...args: unknown[]) => void} [options.warn] - Warning logger
 * @param {number} [options.liveDelayMs=120] - Quiet time before live candidates are requested
 * @param {boolean} [options.predictions=true] - Also ask for predictions (learned history)
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer] - Timer (injectable for tests)
 * @param {(id: unknown) => void} [options.clearTimer] - Timer cancel (injectable for tests)
 * @param {() => number} [options.now] - Clock in ms (statistics)
 * @returns {object} The controller (see the returned object)
 * @example
 * const ime = createIme({ engine: anthy, direct, compose, send });
 * ime.kana('ka', 'center'); // composing "か"
 * await ime.space(); // converting
 * await ime.enter(); // commits and teaches anthy
 */
export const createIme = ({
  engine,
  direct,
  compose,
  send,
  onChange = () => {},
  warn = () => {},
  liveDelayMs = 120,
  predictions = true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => performance.now(),
}) => {
  /** @type {ConversionBackend|null} */
  let active = engine;
  /** @type {Mirror} The reading being composed. */
  let mirror = EMPTY_MIRROR;
  /** @type {Conversion|null} */
  let conv = null;
  /** @type {{reading: string, items: LiveCandidate[], segments: Segment[]}} */
  let live = { reading: '', items: [], segments: [] };
  /** @type {Promise<void>} */
  let queue = Promise.resolve();
  let slowPending = 0;
  /** @type {Promise<void>} The live request in flight (for flush). */
  let liveTask = Promise.resolve();
  const debouncer = createDebouncer({ delayMs: liveDelayMs, setTimer, clearTimer });
  const stats = { queries: 0, stale: 0, failures: 0, lastMs: 0, commits: 0, learned: 0 };

  /**
   * Forget the composition and the conversion.
   * @returns {void}
   * @example
   * clear()
   */
  const clear = () => {
    mirror = EMPTY_MIRROR;
    conv = null;
    compose.reset();
    live = { reading: '', items: [], segments: [] };
    debouncer.cancel();
  };

  /**
   * Stop using the backend and type directly (whatever is composed is typed as shown).
   * @param {string} reason - Why (logged)
   * @returns {void}
   * @example
   * disableEngine('backend gone')
   */
  const disableEngine = (reason) => {
    if (!active) return;
    const shown = conv ? convText(conv) : mirrorText(mirror);
    active = null;
    warn(`conversion disabled, typing hiragana directly: ${reason}`);
    clear();
    if (shown) send(direct.typeText(shown));
    onChange();
  };

  /**
   * Run a task after the queued ones; edits wait behind it.
   * @param {() => Promise<void>|void} task - Task
   * @returns {Promise<void>} Resolves when done
   * @example
   * slow(async () => {})
   */
  const slow = (task) => {
    slowPending += 1;
    const run = queue.then(task).catch((error) => {
      stats.failures += 1;
      warn(`conversion request failed: ${`${error?.message ?? error}`.split('\n')[0]}`);
    }).finally(() => {
      slowPending -= 1;
      onChange();
    });
    queue = run;
    return run;
  };

  /**
   * Whether an edit can be applied right away (nothing queued that changes the composition).
   * @returns {boolean} True when edits apply at once
   * @example
   * canEditNow()
   */
  const canEditNow = () => slowPending === 0;

  /**
   * The text of a conversion (every segment's selected candidate).
   * @param {Conversion} c - Conversion
   * @returns {string} Text
   * @example
   * convText(conv)
   */
  const convText = (c) => c.segments.map((s) => s.candidates[s.sel] ?? s.reading).join('');

  /**
   * Build a conversion from backend segments.
   * @param {string} reading - Reading
   * @param {Segment[]} segments - Segments
   * @returns {Conversion} Conversion (every segment on its first candidate, first segment current)
   * @example
   * toConversion('かんじ', [{ reading: 'かんじ', candidates: ['漢字'] }])
   */
  const toConversion = (reading, segments) => ({
    reading,
    segments: segments.map((s) => ({ reading: s.reading, candidates: s.candidates.length ? s.candidates : [s.reading], sel: 0 })),
    cur: 0,
  });

  /**
   * Apply composer ops to the reading (shown at once) and ask for fresh live candidates.
   * @param {OutputOp[]} ops - Ops from the compose composer
   * @returns {void}
   * @example
   * applyEdit(compose.input('ka', 'center'))
   */
  const applyEdit = (ops) => {
    if (!ops.length) return;
    mirror = applyOps(mirror, ops).mirror;
    if (!mirror.chars.length) live = { reading: '', items: [], segments: [] };
    scheduleLive();
    onChange();
  };

  /**
   * Request live candidates once typing pauses.
   * @returns {void}
   * @example
   * scheduleLive()
   */
  const scheduleLive = () => {
    if (!active || conv || !mirror.chars.length) {
      debouncer.cancel();
      return;
    }
    if (mirrorText(mirror) === live.reading) return;
    debouncer.schedule(() => {
      liveTask = queryLive(mirrorText(mirror));
    });
  };

  /**
   * Fetch the conversion and predictions for a reading and show them if it is still current.
   * @param {string} reading - Reading
   * @returns {Promise<boolean>} True when the candidates were published
   * @example
   * await queryLive('かんじ')
   */
  const queryLive = async (reading) => {
    if (!active || !reading) return false;
    const t0 = now();
    try {
      const [segments, predicted] = await Promise.all([
        active.convert(reading),
        predictions ? active.predict(reading).catch(() => []) : Promise.resolve([]),
      ]);
      stats.lastMs = now() - t0;
      stats.queries += 1;
      if (conv || reading !== mirrorText(mirror)) {
        stats.stale += 1;
        return false;
      }
      const whole = segments.map((s) => s.candidates[0] ?? s.reading).join('');
      live = {
        reading,
        segments,
        items: mergeCandidates({ reading, whole, segment: segments[0]?.candidates ?? [], predictions: predicted }),
      };
      onChange();
      return true;
    } catch (error) {
      stats.failures += 1;
      warn(`live candidates failed: ${`${error?.message ?? error}`.split('\n')[0]}`);
      return false;
    }
  };

  /**
   * Send a committed conversion and let anthy learn it (in the background).
   * @returns {void}
   * @example
   * commitConversion()
   */
  const commitConversion = () => {
    if (!conv) return;
    const c = conv;
    const text = convText(c);
    clear();
    send(direct.typeText(text));
    stats.commits += 1;
    active?.commit({
      reading: c.reading,
      lengths: c.segments.map((s) => len(s.reading)),
      choices: c.segments.map((s) => s.sel),
      texts: c.segments.map((s) => s.candidates[s.sel] ?? s.reading),
    }).then((ok) => {
      if (ok) stats.learned += 1;
    }).catch((error) => warn(`anthy did not learn the commit: ${`${error?.message ?? error}`.split('\n')[0]}`));
    onChange();
  };

  /**
   * Commit whatever is composed or converted (the reading is committed as typed).
   * @returns {void}
   * @example
   * commitAny()
   */
  const commitAny = () => {
    if (conv) {
      commitConversion();
      return;
    }
    if (mirror.chars.length) {
      const text = mirrorText(mirror);
      clear();
      send(direct.typeText(text));
      onChange();
    }
  };

  /**
   * Leave the conversion and go back to editing its reading.
   * @returns {void}
   * @example
   * cancelConversion()
   */
  const cancelConversion = () => {
    if (!conv) return;
    const { reading } = conv;
    conv = null;
    mirror = mirrorOf(reading);
    compose.load(reading);
    scheduleLive();
    onChange();
  };

  /**
   * Start converting the reading (uses the live result when it is for the same reading).
   * @returns {Promise<void>} Resolves when converting
   * @example
   * await startConversion()
   */
  const startConversion = async () => {
    const reading = mirrorText(mirror);
    const segments = live.reading === reading && live.segments.length ? live.segments : await active.convert(reading);
    if (reading !== mirrorText(mirror)) return;
    debouncer.cancel();
    conv = toConversion(reading, segments);
  };

  /**
   * Take a candidate of the current segment: the last segment commits everything (anthy learns
   * every segment), any other segment moves on to the next one.
   * @param {number} index - Candidate index in the current segment
   * @param {string} [text] - The candidate as shown (a changed table is matched by text)
   * @returns {void}
   * @example
   * pickInConversion(2, '器械')
   */
  const pickInConversion = (index, text) => {
    if (!conv) return;
    const seg = conv.segments[conv.cur];
    const at = text === undefined || seg.candidates[index] === text ? index : seg.candidates.indexOf(text);
    if (!(at >= 0 && at < seg.candidates.length)) return;
    seg.sel = at;
    if (conv.cur >= conv.segments.length - 1) {
      commitConversion();
      return;
    }
    conv.cur += 1;
    onChange();
  };

  /**
   * Commit a live candidate (shown before 変換).
   * @param {number} index - Index in the live list
   * @param {string} [text] - The candidate as shown
   * @returns {Promise<void>} Resolves when applied
   * @example
   * await pickLive(0)
   */
  const pickLive = async (index, text) => {
    const reading = mirrorText(mirror);
    let item = live.items[index];
    if (!item || (text !== undefined && item.text !== text) || live.reading !== reading) {
      // The list on screen was for an older reading: refresh and look the same text up again.
      const wanted = text ?? item?.text;
      if (live.reading !== reading) await queryLive(reading);
      item = live.items.find((c) => c.text === wanted);
      if (!item || live.reading !== reading) return;
    }
    switch (item.kind) {
      case 'whole':
        conv = toConversion(reading, live.segments);
        commitConversion();
        return;
      case 'segment':
        conv = toConversion(reading, live.segments);
        pickInConversion(item.index, item.text);
        return;
      case 'prediction': {
        clear();
        send(direct.typeText(item.text));
        stats.commits += 1;
        active?.commitPrediction({ reading, index: item.index, text: item.text })
          .then((ok) => {
            if (ok) stats.learned += 1;
          })
          .catch((error) => warn(`anthy did not learn the prediction: ${`${error?.message ?? error}`.split('\n')[0]}`));
        onChange();
        return;
      }
      default:
        // Hiragana or katakana: nothing to learn.
        clear();
        send(direct.typeText(item.kind === 'katakana' ? toKatakana(reading) : reading));
        onChange();
    }
  };

  /**
   * Resize the current segment by one character (anthy re-segments the rest).
   * @param {number} delta - -1 or +1
   * @returns {Promise<void>} Resolves when resized
   * @example
   * await resizeCurrent(1)
   */
  const resizeCurrent = async (delta) => {
    const c = conv;
    const lengths = c.segments.map((s) => len(s.reading));
    const segments = await active.resize(c.reading, lengths, c.cur, delta);
    if (conv !== c) return;
    const next = toConversion(c.reading, segments);
    // Keep the choices of the segments before the current one.
    for (let i = 0; i < c.cur && i < next.segments.length; i += 1) {
      if (next.segments[i].reading === c.segments[i].reading) next.segments[i].sel = c.segments[i].sel;
    }
    next.cur = Math.min(c.cur, next.segments.length - 1);
    conv = next;
  };

  // ---- Public actions -------------------------------------------------------------------------

  /**
   * Type a kana key (tap or flick).
   * @param {string} keyId - Kana key id
   * @param {string} direction - Flick direction
   * @returns {Promise<void>} Resolves when applied
   * @example
   * kana('a', 'left') // い
   */
  const kana = (keyId, direction) => {
    if (active && !conv && canEditNow()) {
      applyEdit(compose.input(keyId, direction));
      return Promise.resolve();
    }
    return slow(() => {
      if (!active) {
        send(direct.input(keyId, direction));
        return;
      }
      commitAny();
      applyEdit(compose.input(keyId, direction));
    });
  };

  /**
   * Add kana text to the reading (debug API and tests; same path as a key).
   * @param {string} value - Kana text
   * @returns {Promise<void>} Resolves when applied
   * @example
   * kanaText('かんじ')
   */
  const kanaText = (value) => {
    if (active && !conv && canEditNow()) {
      applyEdit(compose.typeText(value));
      return Promise.resolve();
    }
    return slow(() => {
      if (!active) {
        send(direct.typeText(value));
        return;
      }
      commitAny();
      applyEdit(compose.typeText(value));
    });
  };

  /**
   * Type literal text (QWERTY, symbols). Commits any composition first.
   * @param {string|(() => string)} value - Text, or a function called when it is sent
   * @returns {Promise<void>} Resolves when sent
   * @example
   * text('「')
   */
  const text = (value) => slow(() => {
    commitAny();
    send(direct.typeText(typeof value === 'function' ? value() : value));
  });

  /**
   * ゛゜小: change the character before the caret (a conversion goes back to its reading first).
   * @returns {Promise<void>} Resolves when applied
   * @example
   * modify()
   */
  const modify = () => {
    if (active && !conv && canEditNow() && mirror.chars.length) {
      applyEdit(compose.modify());
      return Promise.resolve();
    }
    return slow(() => {
      if (!active || (!conv && !mirror.chars.length)) {
        send(direct.modify());
        return;
      }
      cancelConversion();
      applyEdit(compose.modify());
    });
  };

  /**
   * ⌫: delete in the reading, leave a conversion, or delete in the target when idle.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * backspace()
   */
  const backspace = () => {
    if (active && !conv && canEditNow() && mirror.chars.length) {
      applyEdit(compose.backspace());
      return Promise.resolve();
    }
    return slow(() => {
      if (conv) {
        cancelConversion();
        return;
      }
      if (active && mirror.chars.length) {
        applyEdit(compose.backspace());
        return;
      }
      send(direct.backspace());
    });
  };

  /**
   * ↶: undo the last kana edit, leave a conversion, or undo in the target when idle.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * undo()
   */
  const undo = () => {
    if (active && !conv && canEditNow() && mirror.chars.length) {
      applyEdit(compose.undo());
      return Promise.resolve();
    }
    return slow(() => {
      if (conv) {
        cancelConversion();
        return;
      }
      if (active && mirror.chars.length) {
        applyEdit(compose.undo());
        return;
      }
      send(direct.undo());
    });
  };

  /**
   * ← / →: move the caret in the reading, resize the current segment while converting, or move
   * the target's cursor when idle.
   * @param {'left'|'right'} directionName - Direction
   * @returns {Promise<void>} Resolves when applied
   * @example
   * arrow('left')
   */
  const arrow = (directionName) => {
    const key = { key: directionName === 'left' ? 'ArrowLeft' : 'ArrowRight' };
    if (active && !conv && canEditNow() && mirror.chars.length) {
      applyEdit([key]);
      compose.load(mirror.chars.slice(0, mirror.caret).join(''));
      return Promise.resolve();
    }
    return slow(async () => {
      if (conv) {
        await resizeCurrent(directionName === 'left' ? -1 : 1);
        return;
      }
      if (active && mirror.chars.length) {
        applyEdit([key]);
        compose.load(mirror.chars.slice(0, mirror.caret).join(''));
        return;
      }
      send(direct.arrow(directionName));
    });
  };

  /**
   * 空白: convert, go to the next candidate, or type a space when idle.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * space()
   */
  const space = () => slow(async () => {
    if (conv) {
      const seg = conv.segments[conv.cur];
      seg.sel = (seg.sel + 1) % seg.candidates.length;
      return;
    }
    if (!active || !mirror.chars.length) {
      send(direct.typeText(' '));
      return;
    }
    await startConversion();
  });

  /**
   * ⏎: commit the conversion or the reading; when idle, Enter in the target.
   * @returns {Promise<void>} Resolves when applied
   * @example
   * enter()
   */
  const enter = () => slow(() => {
    if (conv || mirror.chars.length) {
      commitAny();
      return;
    }
    send(direct.enter());
  });

  /**
   * Tap on a candidate: a live candidate while composing, or the current segment's while converting.
   * @param {number} index - Candidate index as shown
   * @param {string} [shownText] - The candidate as shown
   * @returns {Promise<void>} Resolves when applied
   * @example
   * select(1, '器械')
   */
  const select = (index, shownText) => slow(async () => {
    if (!active) return;
    if (conv) {
      pickInConversion(index, shownText);
      return;
    }
    if (mirror.chars.length) await pickLive(index, shownText);
  });

  /**
   * Replace text right before the cursor (commits first).
   * @param {() => number} count - Characters to delete, read when the task runs
   * @param {string} value - Replacement
   * @returns {Promise<void>} Resolves when sent
   * @example
   * replaceTail(() => 4, 'hello ')
   */
  const replaceTail = (count, value) => slow(() => {
    commitAny();
    send(direct.replace(count(), value));
  });

  /**
   * Commit whatever is composed (before switching modes, symbols, ...).
   * @returns {Promise<void>} Resolves when committed
   * @example
   * commitAll()
   */
  const commitAll = () => slow(() => commitAny());

  /**
   * Throw the composition away (keyboard opened).
   * @returns {Promise<void>} Resolves when done
   * @example
   * discard()
   */
  const discard = () => slow(() => {
    direct.reset();
    clear();
  });

  /**
   * Throw the composition away (keyboard closed, overlay disabled).
   * @returns {Promise<void>} Resolves when done
   * @example
   * release()
   */
  const release = discard;

  /**
   * Start using a backend that became available after the controller was created.
   * @param {ConversionBackend} value - Backend
   * @returns {void}
   * @example
   * attachEngine(anthy)
   */
  const attachEngine = (value) => {
    slow(() => {
      if (active || !value) return;
      active = value;
      clear();
    });
  };

  /**
   * Describe what the candidate panel should show.
   * @returns {ImeView} The view
   * @example
   * view().candidates
   */
  const view = () => {
    const none = { preedit: '', caret: 0, segStart: 0, segLength: 0, candidates: [], selected: -1, source: 'none' };
    if (!active) return { phase: 'direct', ...none };
    if (conv) {
      const before = conv.segments.slice(0, conv.cur).map((s) => s.candidates[s.sel] ?? s.reading).join('');
      const seg = conv.segments[conv.cur];
      return {
        phase: 'converting',
        preedit: convText(conv),
        caret: len(before),
        segStart: len(before),
        segLength: len(seg.candidates[seg.sel] ?? seg.reading),
        candidates: seg.candidates,
        selected: seg.sel,
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
        stale: live.items.length > 0 && live.reading !== mirrorText(mirror),
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
    view,
    /**
     * Wait until queued tasks and the live request in flight are done.
     * @returns {Promise<void>} Resolves when idle
     * @example
     * await flush()
     */
    flush: async () => {
      await queue;
      await liveTask;
    },
    /**
     * Live-candidate state and statistics (debug API).
     * @returns {object} Info
     * @example
     * liveInfo().lastMs
     */
    liveInfo: () => ({
      reading: live.reading,
      fresh: live.reading === mirrorText(mirror),
      items: live.items.map((c) => `${c.text}(${c.kind})`),
      ...stats,
    }),
    get busy() {
      return slowPending > 0;
    },
  };
};
