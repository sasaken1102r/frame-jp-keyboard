// Lookups into Steam's runtime objects (SharedJSContext). Everything here only reads Valve's
// objects or calls their public-ish methods; no Valve code is copied. Every lookup is by
// unminified names (method names, m_ fields, string literals), and returns null when missing.
import { warn } from './log.js';

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
 * The stock VR keyboard component registers its handler on exactly one manager with
 * `SetVRKeyboardOnTextEnteredOverride` (the manager of the window that requested the VR keyboard),
 * so the manager whose `m_fnVROnTextEnteredOverride` is set is the one the stock keys feed.
 * Falls back to the first window's manager (the stock code also falls back to the current window).
 * @returns {any|null} The manager, or null when none exists
 * @example
 * pickKeyboardManager()?.HandleVirtualKeyDown('あ', false)
 */
export const pickKeyboardManager = () => {
  const managers = getSteamUIWindows()
    .map((w) => w?.VirtualKeyboardManager)
    .filter((m) => m && typeof m.HandleVirtualKeyDown === 'function');
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
 * How committed text reaches the target (observed in Steam client changelist 11041156).
 *
 * The stock keyboard hands every committed string and every special key to its window's
 * VirtualKeyboardManager through HandleVirtualKeyDown(text, shift). Special keys are passed by
 * name ("Backspace", "Enter", "Tab", "ArrowLeft", "ArrowRight").
 *
 * From there the manager takes care of everything that depends on the target:
 * - Enter handling, such as submitting or closing the keyboard
 * - the VR keyboard's buffered and minimal modes
 * - the choice between SteamVR's keyboard API and Steam's own key injection
 * - the translation of key names into whatever that path expects
 *
 * So we call the same entry point with the same key names. That keeps Enter hooks, buffered vs.
 * minimal mode, Steam UI text fields vs. apps, and the special codes all identical to the stock
 * keyboard, and we never have to know which mode is active. Text is sent one character per call
 * because the buffered-mode handler advances its cursor by one per call regardless of length.
 * Like the stock literal-key path we never hand keys to the stock keyboard's IBus context: kana-kanji
 * conversion runs in our own input context (ibus.js), and only its commit-text arrives here.
 */

/**
 * Create the output function that delivers operations to the active VirtualKeyboardManager.
 * @returns {(ops: ({text: string}|{key: string})[]) => boolean} Sends the ops; false when nothing could be sent
 * @example
 * const send = createOutput();
 * send([{ text: 'あ' }, { key: 'Backspace' }]);
 */
export const createOutput = () => (ops) => {
  if (!ops.length) return true;
  const manager = pickKeyboardManager();
  if (!manager) {
    warn(`no VirtualKeyboardManager; dropping ${ops.length} op(s)`);
    return false;
  }
  try {
    for (const op of ops) {
      if ('key' in op) {
        manager.HandleVirtualKeyDown(op.key, false);
      } else {
        for (const ch of Array.from(op.text)) manager.HandleVirtualKeyDown(ch, false);
      }
    }
    return true;
  } catch (error) {
    warn('HandleVirtualKeyDown failed', error);
    return false;
  }
};
