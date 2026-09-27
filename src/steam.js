// Lookups into Steam's runtime objects (SharedJSContext). Everything here only reads Valve's
// objects or calls their public-ish methods; no Valve code is copied. Every lookup is by
// unminified names (method names, m_ fields, string literals), and returns null when missing.
import { log, warn } from './log.js';
import { planCalls } from './output-plan.js';

/**
 * Gap between calls in buffered VR mode. The buffer component computes each insert from its last
 * render, so it has to re-render between our calls.
 */
const BUFFERED_CALL_GAP_MS = 40;

/**
 * Wait a number of milliseconds (no-op for 0 or less).
 * @param {number} ms - Delay
 * @returns {Promise<void>} Resolves after the delay
 * @example
 * await sleep(50)
 */
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
/** True while our output is inside a HandleVirtualKeyDown call (tells our calls from stock ones). */
let sending = false;

/**
 * Whether the current HandleVirtualKeyDown call comes from our keyboard (for the debug recorder).
 * @returns {boolean} True inside our own call
 * @example
 * isOurCall() // false
 */
export const isOurCall = () => sending;

/**
 * Get every VirtualKeyboardManager (one per Steam UI window), in window order.
 * @returns {any[]} Managers
 * @example
 * getKeyboardManagers().length
 */
export const getKeyboardManagers = () => getSteamUIWindows()
  .map((w) => w?.VirtualKeyboardManager)
  .filter((m) => m && typeof m.HandleVirtualKeyDown === 'function');

/** VR overlay key of the stock keyboard popup ("SteamVR - Keyboard"). */
export const KEYBOARD_OVERLAY_KEY = 'valve.steam.gamepadui.keyboard';

/**
 * Get webpack's require function from Steam's chunk registry.
 * Pushing a chunk with an unknown id makes the runtime call our callback with `require`.
 * @returns {((id: string) => any) & {m: Record<string, Function>}|null} The require function, or null
 * @example
 * getWebpackRequire()?.m // module factories
 */
export const getWebpackRequire = () => {
  try {
    const registry = globalThis.webpackChunksteamui;
    if (!registry?.push) return null;
    let req = null;
    registry.push([[Symbol('fjk')], {}, (r) => {
      req = r;
    }]);
    return req?.m ? req : null;
  } catch (error) {
    warn('webpack require lookup failed', error);
    return null;
  }
};

/**
 * Find the store that exposes `VRKeyboardStatus` ({bIsOpen, bMinimal, sOverlayKey, ...}).
 * Only modules whose source mentions the getter are required, so no unrelated module runs.
 * @param {((id: string) => any) & {m: Record<string, Function>}|null} req - webpack require
 * @returns {{VRKeyboardStatus: {bIsOpen: boolean, bMinimal: boolean}}|null} The store, or null
 * @example
 * findVRStatusStore(getWebpackRequire())?.VRKeyboardStatus.bIsOpen
 */
export const findVRStatusStore = (req) => {
  if (!req) return null;
  for (const id of Object.keys(req.m)) {
    try {
      if (!String(req.m[id]).includes('get VRKeyboardStatus()')) continue;
      const exports = req(id);
      for (const value of Object.values(exports ?? {})) {
        if (value && typeof value === 'object' && 'VRKeyboardStatus' in value) {
          const status = value.VRKeyboardStatus;
          if (status && typeof status.bIsOpen === 'boolean') return value;
        }
      }
    } catch {
      // Keep looking.
    }
  }
  return null;
};

/**
 * Get the Steam UI window instances (each has a VirtualKeyboardManager).
 * @returns {any[]} Window instances (empty when not available yet)
 * @example
 * getSteamUIWindows().length
 */
export const getSteamUIWindows = () => {
  try {
    const windows = globalThis.SteamUIStore?.WindowStore?.SteamUIWindows;
    return Array.isArray(windows) ? windows : [];
  } catch {
    return [];
  }
};

/**
 * Pick the VirtualKeyboardManager the stock VR keyboard is currently typing into.
 *
 * While the VR keyboard is shown, Steam sets a text handler on the manager of the window it types
 * for (`m_fnVROnTextEnteredOverride`), so that manager is the one to use. Falls back to the first
 * window's manager.
 * @returns {any|null} The manager, or null when none exists
 * @example
 * pickKeyboardManager()?.HandleVirtualKeyDown('あ', false)
 */
export const pickKeyboardManager = () => {
  const managers = getKeyboardManagers();
  return managers.find((m) => typeof m.m_fnVROnTextEnteredOverride === 'function') ?? managers[0] ?? null;
};

/**
 * Get the window of the stock VR keyboard popup.
 * @returns {Window|null} The popup window, or null when it does not exist (yet)
 * @example
 * getKeyboardPopupWindow()?.document
 */
export const getKeyboardPopupWindow = () => {
  try {
    const popup = globalThis.g_PopupManager?.GetPopupForVROverlayKey?.(KEYBOARD_OVERLAY_KEY);
    const win = popup?.m_popup || popup?.window || null;
    if (!win || win.closed || !win.document) return null;
    return win;
  } catch {
    return null;
  }
};

/**
 * Check the objects the keyboard cannot work without.
 * @returns {string[]} Names of missing prerequisites (empty = all present)
 * @example
 * missingPrerequisites() // []
 */
export const missingPrerequisites = () => {
  const missing = [];
  if (typeof globalThis.g_PopupManager?.GetPopupForVROverlayKey !== 'function') missing.push('g_PopupManager.GetPopupForVROverlayKey');
  if (!pickKeyboardManager()) missing.push('SteamUIStore.WindowStore.SteamUIWindows[].VirtualKeyboardManager.HandleVirtualKeyDown');
  return missing;
};

/*
 * How committed text reaches the target: we call the manager's public entry point
 * HandleVirtualKeyDown(text, shift) with text or with a key name ("Backspace", "Enter", "Tab",
 * "ArrowLeft", ...). The manager then deals with everything that depends on the target (Enter
 * handling, the VR keyboard's buffered and minimal modes, and how the text is delivered). How text
 * is split into calls depends on the mode; see output-plan.js. Kana-kanji conversion runs in the
 * injector (libanthy, see anthy-client.js); only committed text arrives here.
 */

/**
 * Whether the VR keyboard is typing for another overlay than the manager's own Steam window (for
 * example a gamescope app window): the keyboard's target overlay key differs from the window's, and the
 * running app id does not match either.
 * @param {{bIsOpen?: boolean, sOverlayKey?: string, unAppID?: number}|null|undefined} status - VRKeyboardStatus
 * @param {string|undefined} windowKey - The Steam window's VR overlay key
 * @param {number|undefined} windowAppId - The Steam window's main running app id
 * @returns {boolean} True only when the keyboard is open for a known, different overlay
 * @example
 * isForeignKeyboardTarget({ bIsOpen: true, sOverlayKey: 'gamescope.gamescope-0.window.72', unAppID: 0 }, 'valve.steam.gamepadui.main', undefined) // true
 */
export const isForeignKeyboardTarget = (status, windowKey, windowAppId) => {
  if (!status?.bIsOpen || !status.sOverlayKey) return false;
  if (status.sOverlayKey === windowKey) return false;
  return !(status.unAppID && status.unAppID === windowAppId);
};

/**
 * Whether an Enter would be swallowed by a Steam UI field's Enter hook that does not belong to the
 * keyboard's target. A focused field in Steam's own window can register an Enter handler with the
 * manager (`m_ActiveElementProps.onEnterKeyPress`), and HandleVirtualKeyDown('Enter') gives the Enter
 * to that handler. When the VR keyboard types into another window (a gamescope app), such a handler
 * is left over from the Steam field, and the app would never get the Enter.
 * @param {any} manager - VirtualKeyboardManager
 * @param {object|null|undefined} status - VRKeyboardStatus
 * @returns {boolean} True when the Enter should skip the hook and go straight to DispatchKeypress
 * @example
 * enterHookIsForeign(pickKeyboardManager(), status) // true while typing into a gamescope app
 */
export const enterHookIsForeign = (manager, status) => {
  try {
    if (!manager?.m_ActiveElementProps?.onEnterKeyPress || typeof manager.DispatchKeypress !== 'function') return false;
    const window = getSteamUIWindows().find((w) => w?.VirtualKeyboardManager === manager);
    return isForeignKeyboardTarget(status, window?.GetVROverlayKey?.(), window?.MainRunningAppID);
  } catch {
    return false;
  }
};

/**
 * Create the output function that delivers operations to the active VirtualKeyboardManager.
 * @param {() => {buffered: boolean, vrStatus?: object}} [getMode] - Reports whether the VR keyboard
 *   is in buffered mode, and the VRKeyboardStatus
 * @returns {(ops: ({text: string}|{key: string})[]) => boolean} Queues the ops; false when nothing could be sent
 * @example
 * const send = createOutput();
 * send([{ text: 'あ' }, { key: 'Backspace' }]);
 */
export const createOutput = (getMode = () => ({ buffered: false })) => {
  /** Deliveries run one after another, so spaced (buffered) calls never interleave. */
  let queue = Promise.resolve();

  /**
   * Make the calls for one batch of operations.
   * @param {any} manager - VirtualKeyboardManager
   * @param {string[]} calls - Strings for HandleVirtualKeyDown
   * @param {boolean} buffered - Wait for the VR buffer component to re-render between calls
   * @param {object|undefined} vrStatus - VRKeyboardStatus (for the Enter handler check)
   * @returns {Promise<void>} Resolves when all calls are made
   * @example
   * await deliver(manager, ['かんじ', 'Enter'], false, status)
   */
  const deliver = async (manager, calls, buffered, vrStatus) => {
    for (const [i, call] of calls.entries()) {
      if (buffered && i > 0) await sleep(BUFFERED_CALL_GAP_MS);
      sending = true;
      try {
        if (call === 'Enter' && enterHookIsForeign(manager, vrStatus)) {
          log("enter: sent past a Steam field's Enter handler (the keyboard types into another window)");
          manager.DispatchKeypress('Enter');
        } else {
          manager.HandleVirtualKeyDown(call, false);
        }
      } finally {
        sending = false;
      }
    }
  };

  return (ops) => {
    if (!ops.length) return true;
    const manager = pickKeyboardManager();
    if (!manager) {
      warn(`no VirtualKeyboardManager; dropping ${ops.length} op(s)`);
      return false;
    }
    const { buffered, vrStatus } = getMode();
    const calls = planCalls(ops, { buffered });
    queue = queue
      .then(() => deliver(manager, calls, buffered, vrStatus))
      .catch((error) => warn('HandleVirtualKeyDown failed', error));
    return true;
  };
};
