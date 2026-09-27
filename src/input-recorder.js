// Temporary, passive recorder of raw VR input around key presses (0.6.3 investigation of the
// two-laser case). Numbers only: no text, no key labels. Each entry is a compact array:
//   touch:   ['t', ms, type, identifier, x, y, touches.length]   type: s(tart) m(ove) e(nd) c(ancel)
//   pointer: ['p', ms, type, pointerType, pointerId, x, y, buttons]   type: d(own) m(ove) u(p) c(ancel)
//   cursor:  ['c', ms, ...raw callback arguments]
// For every press it logs one window, from 300 ms before touchstart to 300 ms after touchend.

/** Time around a press that is logged. */
export const WINDOW_MS = 300;
/** Entries kept in memory (two cursors at ~90 Hz = ~180/s). */
const MAX_ENTRIES = 2000;

/**
 * Round a number for the log.
 * @param {unknown} v - Value
 * @returns {unknown} Rounded number, or the value as-is when not a number
 * @example
 * r(12.345) // 12.3
 */
const r = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

/**
 * Create the recorder.
 * @param {object} options - Options
 * @param {(windowEntries: {press: number, entries: any[]}) => void} options.onWindow - Called with each finished window
 * @param {() => number} [options.now] - Clock in ms
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer] - Timer (tests)
 * @returns {{touch: (e: TouchEvent) => void, pointer: (e: PointerEvent) => void, cursor: (...args: unknown[]) => void, readonly size: number}} Recorder
 * @example
 * const rec = createInputRecorder({ onWindow: (w) => console.log(w) });
 * doc.addEventListener('touchstart', rec.touch, { capture: true, passive: true });
 */
export const createInputRecorder = ({ onWindow, now = () => performance.now(), setTimer = setTimeout }) => {
  /** @type {any[][]} */
  let entries = [];
  let pressStart = null;
  let presses = 0;

  /**
   * Store one entry.
   * @param {any[]} entry - Entry
   * @returns {void}
   * @example
   * push(['c', 12, 1, true, 10, 20])
   */
  const push = (entry) => {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES / 2);
  };

  /**
   * Emit the window around a finished press.
   * @param {number} start - touchstart time
   * @param {number} end - touchend time
   * @returns {void}
   * @example
   * emit(100, 400)
   */
  const emit = (start, end) => {
    const from = start - WINDOW_MS;
    const to = end + WINDOW_MS;
    const picked = entries.filter((e) => e[1] >= from && e[1] <= to).map((e) => [e[0], Math.round(e[1] - start), ...e.slice(2)]);
    presses += 1;
    onWindow({ press: presses, entries: picked });
  };

  return {
    /**
     * Record a touch event (listen in the capture phase, passive).
     * @param {TouchEvent} e - Event
     * @returns {void}
     * @example
     * touch(event)
     */
    touch: (e) => {
      const t = now();
      const type = { touchstart: 's', touchmove: 'm', touchend: 'e', touchcancel: 'c' }[e.type] ?? e.type;
      for (const touch of Array.from(e.changedTouches ?? [])) {
        push(['t', t, type, touch.identifier, r(touch.clientX), r(touch.clientY), e.touches?.length ?? -1]);
      }
      if (type === 's' && pressStart === null) pressStart = t;
      if ((type === 'e' || type === 'c') && pressStart !== null && (e.touches?.length ?? 0) === 0) {
        const start = pressStart;
        pressStart = null;
        setTimer(() => emit(start, t), WINDOW_MS + 10);
      }
    },
    /**
     * Record a pointer event.
     * @param {PointerEvent} e - Event
     * @returns {void}
     * @example
     * pointer(event)
     */
    pointer: (e) => {
      const type = { pointerdown: 'd', pointermove: 'm', pointerup: 'u', pointercancel: 'c' }[e.type] ?? e.type;
      push(['p', now(), type, e.pointerType, e.pointerId, r(e.clientX), r(e.clientY), e.buttons]);
    },
    /**
     * Record a raw cursor callback (all its arguments).
     * @param {...unknown} args - Callback arguments
     * @returns {void}
     * @example
     * cursor(1, true, 400, 120)
     */
    cursor: (...args) => push(['c', now(), ...args.map(r)]),
    get size() {
      return entries.length;
    },
  };
};
