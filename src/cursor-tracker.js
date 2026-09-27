// Which VR laser is pressing, and where it is. Pure logic, no DOM.
//
// Measured on the device: with both controllers pointing at the keyboard, the popup gets only one
// DOM touch (one identifier), and a press with the second hand arrives as touchstart + touchend at
// the same point with no touchmove, so every flick with that hand became a tap. SteamVR reports both
// laser cursors separately through the popup window's
// SteamClient.OpenVR.VROverlay.RegisterForCursorMovement((index, active, x, y) => ...) at ~90 Hz,
// also while the trigger is held, with x/y as client coordinates of the popup.
//
// Event model, from raw recordings on the device:
//   - Only the laser SteamVR currently focuses streams (index, true, x, y) while hovering.
//   - A press is announced by (index, false, 0, 0) from the PRESSING laser 1-4 ms before touchstart.
//   - The focused laser keeps streaming (index, true, x, y) during the press (touchmove arrives too).
//     The other laser sends nothing at all during its press, and its touchend has the start point.
//   - At release the pressing laser sends (index, false, x, y) with its RELEASE position, within a
//     millisecond of touchend (e.g. press at (611, 29), release event (632, -100): an up flick).
//   - Positions are in the same CSS px as touch clientX/Y (release (615,-78) vs touchend (613,-78)).
// So the presser is the laser of the press marker, the end point is its release event, and its
// stream (when it has one) drives the live flick guide.

/** How far (CSS px) a cursor may be from the touch point to be taken as the pressing one. */
export const CURSOR_TOLERANCE_PX = 48;
/** A press marker / release event this close (ms) to touchstart / touchend belongs to that press. */
export const EVENT_WINDOW_MS = 80;

/**
 * @typedef {{active: boolean, x: number, y: number, moves: number}} CursorState
 */

/**
 * Create the cursor tracker.
 * @param {object} [options] - Options
 * @param {number} [options.tolerance=CURSOR_TOLERANCE_PX] - Max distance between touch and cursor
 * @param {number[]} [options.scales=[1]] - Candidate factors from cursor to touch coordinates
 *   (e.g. [1, dpr, 1/dpr]); the first one that fits a press is kept for the rest of the session
 * @param {() => number} [options.now] - Clock in ms
 * @returns {{
 *   update: (index: number, active: boolean, x: number, y: number) => void,
 *   pick: (x: number, y: number) => ({index: number, scale: number, distance: number}|null),
 *   pressingIndex: (t?: number) => (number|null),
 *   releasePoint: (index: number, t?: number) => ({x: number, y: number}|null),
 *   position: (index: number) => (CursorState|null),
 *   snapshot: () => object[],
 *   readonly scale: number|null,
 * }} The tracker
 * @example
 * const t = createCursorTracker();
 * t.update(1, true, 100, 50);
 * t.pick(102, 49) // { index: 1, scale: 1, distance: 2.2 }
 */
export const createCursorTracker = ({ tolerance = CURSOR_TOLERANCE_PX, scales = [1], now = () => performance.now() } = {}) => {
  /** @type {Map<number, CursorState>} */
  const cursors = new Map();
  /** @type {{index: number, t: number}|null} Last press marker: (index, false, 0, 0). */
  let lastMarker = null;
  /** @type {Map<number, {x: number, y: number, t: number}>} Last release event per cursor: (index, false, x, y). */
  const releases = new Map();
  /** @type {number|null} */
  let learnedScale = null;

  /**
   * Record a cursor report. A cursor that leaves keeps its last position but becomes inactive.
   * @param {number} index - Cursor index (one per controller)
   * @param {boolean} active - Whether the cursor is on the popup
   * @param {number} x - X in cursor coordinates
   * @param {number} y - Y in cursor coordinates
   * @returns {void}
   * @example
   * update(0, true, 10, 20)
   */
  const update = (index, active, x, y) => {
    const previous = cursors.get(index);
    if (!active) {
      if (previous) previous.active = false;
      if (x === 0 && y === 0) lastMarker = { index, t: now() };
      else releases.set(index, { x, y, t: now() });
      return;
    }
    cursors.set(index, { active: true, x, y, moves: (previous?.moves ?? 0) + 1 });
  };

  /**
   * Find the active cursor that is pressing at a touch point.
   * @param {number} x - Touch clientX
   * @param {number} y - Touch clientY
   * @returns {{index: number, scale: number, distance: number}|null} The cursor, or null when none is close enough
   * @example
   * pick(120, 80)
   */
  const pick = (x, y) => {
    const factors = learnedScale === null ? scales : [learnedScale];
    let best = null;
    for (const [index, c] of cursors) {
      if (!c.active) continue;
      for (const scale of factors) {
        const distance = Math.hypot(c.x * scale - x, c.y * scale - y);
        if (!best || distance < best.distance) best = { index, scale, distance };
      }
    }
    if (!best || best.distance > tolerance) return null;
    learnedScale = best.scale;
    return { ...best, distance: Math.round(best.distance * 10) / 10 };
  };

  /**
   * The laser that announced a press just before a touchstart ((index, false, 0, 0)).
   * @param {number} [t=now()] - Time of the touchstart
   * @returns {number|null} Cursor index, or null when no marker is that recent
   * @example
   * pressingIndex()
   */
  const pressingIndex = (t = now()) => (lastMarker && Math.abs(t - lastMarker.t) <= EVENT_WINDOW_MS ? lastMarker.index : null);

  /**
   * The release position a laser reported around a touchend ((index, false, x, y)).
   * @param {number} index - Cursor index
   * @param {number} [t=now()] - Time of the touchend
   * @returns {{x: number, y: number}|null} Release point, or null when none is that recent
   * @example
   * releasePoint(0)
   */
  const releasePoint = (index, t = now()) => {
    const r = releases.get(index);
    return r && Math.abs(t - r.t) <= EVENT_WINDOW_MS ? { x: r.x, y: r.y } : null;
  };

  return {
    update,
    pick,
    pressingIndex,
    releasePoint,
    /**
     * Latest state of a cursor.
     * @param {number} index - Cursor index
     * @returns {CursorState|null} State, or null when never seen
     * @example
     * position(1)?.x
     */
    position: (index) => cursors.get(index) ?? null,
    /**
     * All cursors, for the gesture log (numbers only).
     * @returns {object[]} Cursor states
     * @example
     * snapshot()
     */
    snapshot: () => [...cursors].map(([index, c]) => ({ index, active: c.active, x: Math.round(c.x), y: Math.round(c.y) })),
    get scale() {
      return learnedScale;
    },
  };
};
