// State machine behind the small update indicator drawn by ui.js. DOM-free (pure logic plus one
// `send` side effect), so it is unit-testable without a popup document.
//
// Talks to the injector (frame_jp_keyboard_injector.py) over the CDP bridge it adds with
// Runtime.addBinding: we call window.fjkUpdateBridge(json) to ask for a forced check or an install,
// and the injector calls window.__fjk.updater.receive(message) back (see main.js) with the answer.
// The injector also calls receive() on its own (at start, then at most hourly) when
// fjk.settings.updateCheck allows it; those unsolicited answers only raise the badge, never the
// banner, so a passing automatic check never interrupts typing.
import { UPDATE_STRINGS } from './update-strings.js';

/**
 * @typedef {object} UpdateBanner
 * @property {'checking'|'toast'|'confirm'|'dismissable'} kind - Banner layout
 * @property {string} [title] - Main line
 * @property {string} [detail] - Secondary line (confirm hint)
 * @property {string} [yes] - Confirm button label (kind === 'confirm')
 * @property {string} [no] - Cancel button label (kind === 'confirm')
 * @property {string} [close] - Close button label (kind === 'dismissable')
 */

/**
 * @typedef {object} UpdateView
 * @property {boolean} badge - Show a dot on the indicator (an update is known to be available)
 * @property {UpdateBanner|null} banner - Banner to draw near the indicator, or none
 */

/** How long an up-to-date / installed toast stays up before it clears itself. */
export const TOAST_MS = 4000;

/**
 * Whether the update indicator is shown: it steps aside while anything is being typed (a kana
 * reading or conversion, or an English word), so it never competes with the text in progress.
 * Only its visibility changes; the badge and banner state stay as they are.
 * @param {object} typing - What is being typed right now
 * @param {boolean} typing.kanaComposing - A kana reading or conversion is in progress
 * @param {string} typing.englishWord - The English word being composed ('' when none)
 * @returns {boolean} True to show the indicator
 * @example
 * isIndicatorShown({ kanaComposing: false, englishWord: 'helo' }) // false
 */
export const isIndicatorShown = ({ kanaComposing, englishWord }) => !kanaComposing && !englishWord;

/**
 * Substitute the one %s placeholder used by strings.md-derived text.
 * @param {string} template - Format string with at most one %s
 * @param {string} value - Value to insert
 * @returns {string} Formatted string
 * @example
 * fmt('v%s があります', '0.6.0') // "v0.6.0 があります"
 */
const fmt = (template, value) => template.replace('%s', value);

/**
 * Create the update indicator's controller.
 * @param {object} deps - Dependencies
 * @param {'ja'|'en'} deps.lang - Display language (Steam's language; this keyboard has no language setting of its own)
 * @param {(message: {action: 'check'|'install'}) => void} deps.send - Send a request to the injector over the CDP bridge
 * @param {() => void} deps.onChange - Called after any state change, to schedule a redraw
 * @param {(...args: unknown[]) => void} [deps.warn] - Logger for malformed messages (defaults to a no-op)
 * @returns {{
 *   readonly view: UpdateView,
 *   tapIndicator: () => void,
 *   tapConfirmYes: () => void,
 *   tapConfirmNo: () => void,
 *   tapDismiss: () => void,
 *   receive: (message: object) => void,
 * }} The controller
 * @example
 * const updater = createUpdater({ lang: 'ja', send: (m) => fjkUpdateBridge(JSON.stringify(m)), onChange: scheduleRender });
 * updater.tapIndicator(); // asks the injector to check now, ignoring its 24h cache
 */
export const createUpdater = ({ lang, send, onChange, warn = () => {} }) => {
  const t = UPDATE_STRINGS[lang] ?? UPDATE_STRINGS.ja;
  /** @type {UpdateView} */
  let view = { badge: false, banner: null };
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let toastTimer;

  /**
   * Text for an error code, falling back to "other" for codes this keyboard doesn't know yet.
   * @param {string|undefined} code - Error code from frame-update.sh
   * @returns {string} Short reason text
   * @example
   * errorText('network')
   */
  const errorText = (code) => t.errors[code] ?? t.errors.other;

  /**
   * Replace the banner and (re)schedule its auto-dismiss if it is a toast.
   * @param {UpdateBanner|null} banner - New banner, or null to hide it
   * @returns {void}
   * @example
   * setBanner({ kind: 'toast', title: 'ok' })
   */
  const setBanner = (banner) => {
    clearTimeout(toastTimer);
    toastTimer = undefined;
    view = { ...view, banner };
    if (banner?.kind === 'toast') toastTimer = setTimeout(() => setBanner(null), TOAST_MS);
    onChange?.();
  };

  /**
   * Tap the indicator: force a check right now, ignoring frame-update.sh's 24h cache.
   * @returns {void}
   * @example
   * updater.tapIndicator()
   */
  const tapIndicator = () => {
    setBanner({ kind: 'checking', title: t.checking });
    send({ action: 'check' });
  };

  /**
   * Confirm the offered update: ask the injector to install it (systemd-run --detach).
   * @returns {void}
   * @example
   * updater.tapConfirmYes()
   */
  const tapConfirmYes = () => {
    view = { ...view, badge: false };
    setBanner({ kind: 'checking', title: t.installing });
    send({ action: 'install' });
  };

  /**
   * Dismiss the confirmation without installing (the badge is left on: it is still available).
   * @returns {void}
   * @example
   * updater.tapConfirmNo()
   */
  const tapConfirmNo = () => setBanner(null);

  /**
   * Dismiss an error or manual-update banner.
   * @returns {void}
   * @example
   * updater.tapDismiss()
   */
  const tapDismiss = () => setBanner(null);

  /**
   * Handle a check answer (frame-update.sh's `check` JSON).
   * @param {object} answer - `{status, current, latest, url, installable, reason, error}`
   * @param {boolean} forced - Whether this answers a tap (vs. the injector's own startup/hourly check)
   * @returns {void}
   * @example
   * handleCheck({ status: 'up-to-date', current: '0.5.3' }, true)
   */
  const handleCheck = (answer, forced) => {
    if (answer.status === 'update-available') {
      view = { ...view, badge: true };
      if (!forced) {
        onChange?.();
        return;
      }
      setBanner(answer.installable
        ? { kind: 'confirm', title: fmt(t.confirmFormat, answer.latest), detail: t.confirmHint, yes: t.confirmYes, no: t.confirmNo }
        : { kind: 'dismissable', title: fmt(t.availableFormat, answer.latest), detail: t.manual, close: t.dismiss });
      return;
    }
    view = { ...view, badge: false };
    if (!forced) {
      onChange?.();
      return;
    }
    if (answer.status === 'up-to-date') {
      setBanner({ kind: 'toast', title: fmt(t.upToDateFormat, answer.current) });
    } else {
      setBanner({ kind: 'dismissable', title: `${t.checkFailedPrefix}${errorText(answer.error)}`, close: t.dismiss });
    }
  };

  /**
   * Handle an install-progress answer (frame-update.sh's `install`/`status` JSON).
   * @param {object} answer - `{state, error, ...}`; state is running / done / failed (idle is ignored)
   * @returns {void}
   * @example
   * handleInstall({ state: 'failed', error: 'checksum-mismatch' })
   */
  const handleInstall = (answer) => {
    if (answer.state === 'running') setBanner({ kind: 'checking', title: t.installing });
    else if (answer.state === 'failed') setBanner({ kind: 'dismissable', title: `${t.installFailedPrefix}${errorText(answer.error)}`, close: t.dismiss });
    else if (answer.state === 'done') setBanner({ kind: 'toast', title: t.installed });
    // 'idle': nothing is running (e.g. the first status poll before install() reaches the script); leave the banner as is.
  };

  /**
   * Handle a message pushed from the injector.
   * @param {object} message - `{source: 'check'|'install'|'state', forced?: boolean, answer: object}`
   * @returns {void}
   * @example
   * updater.receive({ source: 'check', forced: true, answer: { status: 'up-to-date', current: '0.5.3' } })
   */
  const receive = (message) => {
    if (!message || typeof message !== 'object' || !message.answer || typeof message.answer !== 'object') {
      warn('update: malformed message from injector', message);
      return;
    }
    if (message.source === 'check') handleCheck(message.answer, !!message.forced);
    else if (message.source === 'install' || message.source === 'state') handleInstall(message.answer);
    else warn('update: unknown message source', message.source);
  };

  return {
    get view() {
      return view;
    },
    tapIndicator,
    tapConfirmYes,
    tapConfirmNo,
    tapDismiss,
    receive,
  };
};
