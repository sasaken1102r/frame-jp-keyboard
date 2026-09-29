// Temporary, passive recorder of the calls that deliver text, to find the path the stock keyboard
// really uses (0.6.5: the stock keyboard showed no digits, and none of its commits appeared in the
// VirtualKeyboardManager instance methods we had wrapped). It wraps and forwards:
//   - VirtualKeyboardManager methods on the class prototype (every instance, also ones that are not
//     in SteamUIWindows) and on instances that have them as own properties: HandleVirtualKeyDown,
//     DispatchKeypress, and the calls that set or clear the keyboard target
//   - SteamClient.Input.ControllerKeyboardSendText / ControllerKeyboardSetKeyState / SetGamepadKeyboardText,
//     SteamClient.OpenVR.Keyboard.SendText, SteamClient.Browser.Paste
//   - IBus input contexts (Steam's IBus binding, which only the stock keyboard uses): process_key_event
//     (with whether IBus handled the key), focus, reset, set_engine, and the commit-text /
//     forward-key-event / delete-surrounding-text signals of contexts connected after install
// and logs, per call: the method, who called (ours or stock), key names for special keys, and for
// text only its length and class (ascii / non-ascii / mixed) — never the text or the typed key.
// Everything is forwarded unchanged; uninstall() puts the original functions back.

/** Key names that are logged by name (they are not typed text). */
const KEY_NAMES = new Set(['Backspace', 'Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'VKClose', 'VKDone', 'VKPaste', '\b', '\n', '\t']);
/** IBus keyvals logged by name; any other keyval is logged as "char". */
const KEYVAL_NAMES = new Map([[0xff0d, 'Return'], [0xff08, 'BackSpace'], [0xff09, 'Tab'], [0xff1b, 'Escape'], [0x20, 'space'],
  [0xff51, 'Left'], [0xff52, 'Up'], [0xff53, 'Right'], [0xff54, 'Down'], [0xff55, 'Page_Up'], [0xff56, 'Page_Down']]);
/** VirtualKeyboardManager methods to record. */
const VKM_METHODS = ['HandleVirtualKeyDown', 'DispatchKeypress', 'ShowVirtualKeyboard', 'SetActiveVirtualKeyboardTarget', 'ClearCurrentVirtualKeyboardRef'];
/** IBus input context signals whose handlers are recorded. */
const IBUS_SIGNALS = new Set(['commit-text', 'forward-key-event', 'delete-surrounding-text']);

/**
 * Describe an argument without revealing text.
 * @param {unknown} value - Argument
 * @returns {string|number|boolean|null} Key name, number, boolean, or "text:<len>:<class>"
 * @example
 * describe('かんじ') // "text:3:non-ascii"
 * describe('Enter') // "Enter"
 */
export const describe = (value) => {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value ?? null;
  if (typeof value === 'object' && typeof value.text === 'string') return `ibus-${describe(value.text)}`;
  if (typeof value !== 'string') return typeof value;
  if (KEY_NAMES.has(value)) return JSON.stringify(value).slice(1, -1);
  const chars = Array.from(value);
  const ascii = chars.filter((c) => c.charCodeAt(0) < 0x80).length;
  const kind = ascii === chars.length ? 'ascii' : ascii === 0 ? 'non-ascii' : 'mixed';
  return `text:${chars.length}:${kind}`;
};

/**
 * Describe an IBus keyval without revealing which character it types.
 * @param {unknown} keyval - Keyval
 * @returns {string} Key name for special keys, else "char"
 * @example
 * describeKeyval(0xff0d) // "Return"
 * describeKeyval(0x61) // "char"
 */
export const describeKeyval = (keyval) => KEYVAL_NAMES.get(Number(keyval)) ?? 'char';

/**
 * Install the recorder.
 * @param {object} options - Options
 * @param {() => any[]} options.getManagers - Current VirtualKeyboardManager instances
 * @param {() => boolean} options.isOurs - True while our keyboard is sending (to tell ours from stock)
 * @param {(entry: object) => void} options.onCall - Called with each recorded call
 * @param {(label: string, target: object, args: unknown[]) => (object|undefined)} [options.extra] - Extra
 *   fields for an entry (e.g. the manager's Enter state); must not return text
 * @param {object} [options.client=globalThis.SteamClient] - SteamClient object
 * @param {object} [options.ibus=globalThis.IBus] - Steam's IBus binding
 * @returns {{refresh: () => void, uninstall: () => void, count: number}} Controls (refresh wraps newly
 *   seen managers; count is the number of wrapped methods)
 * @example
 * const rec = installApiRecorder({ getManagers, isOurs: () => sending, onCall: (e) => log(e) });
 */
export const installApiRecorder = ({ getManagers, isOurs, onCall, extra = () => undefined, client = globalThis.SteamClient, ibus = globalThis.IBus }) => {
  /** @type {{target: object, name: string, original: Function}[]} */
  const wrapped = [];
  /** Methods currently inside a wrapper (a bound instance method calling the prototype one logs once). */
  const busy = new Set();
  let last = performance.now();

  /**
   * Make a log entry (never throws).
   * @param {string} fn - Label
   * @param {object} self - The object called
   * @param {unknown[]} args - Arguments
   * @param {(args: unknown[]) => unknown[]} mapArgs - Argument describer
   * @returns {object|null} Entry
   * @example
   * entryFor('VKM0.HandleVirtualKeyDown', manager, ['あ', false], (a) => a.map(describe))
   */
  const entryFor = (fn, self, args, mapArgs) => {
    const now = performance.now();
    try {
      return { fn, by: isOurs() ? 'ours' : 'stock', args: mapArgs(args), dt: Math.round(now - last), ...extra(fn, self, args) };
    } catch {
      return null;
    } finally {
      last = now;
    }
  };

  /**
   * Log an entry (never throws).
   * @param {object|null} entry - Entry
   * @returns {void}
   * @example
   * emit({ fn: 'x' })
   */
  const emit = (entry) => {
    try {
      if (entry) onCall(entry);
    } catch {
      // Never let logging break delivery.
    }
  };

  /**
   * Replace a method, also when it is a read-only but configurable property (Steam's IBus prototypes).
   * @param {object} target - Object holding the method
   * @param {string} name - Method name
   * @param {Function} fn - New function
   * @returns {boolean} True when the method is now fn
   * @example
   * setMethod(proto, 'reset', wrapper)
   */
  const setMethod = (target, name, fn) => {
    try {
      target[name] = fn;
    } catch {
      // Try defineProperty below.
    }
    if (target[name] === fn) return true;
    try {
      const own = Object.getOwnPropertyDescriptor(target, name);
      if (!own?.configurable) return false;
      Object.defineProperty(target, name, { ...own, value: fn });
      return target[name] === fn;
    } catch {
      return false;
    }
  };

  /**
   * Wrap one method so every call is recorded and forwarded.
   * @param {object|undefined} target - Object holding the method
   * @param {string} name - Method name
   * @param {string|((self: object) => string)} label - Name in the log (or a function of `this`)
   * @param {object} [options] - Options
   * @param {(args: unknown[]) => unknown[]} [options.mapArgs] - Argument describer (default: describe each)
   * @param {(result: unknown) => unknown} [options.mapResult] - Log after the (awaited) result, with this
   * @param {(args: unknown[]) => void} [options.beforeCall] - May replace arguments (e.g. wrap callbacks)
   * @returns {void}
   * @example
   * wrap(SteamClient.Input, 'ControllerKeyboardSendText', 'Input.SendText')
   */
  const wrap = (target, name, label, { mapArgs = (a) => a.map(describe), mapResult, beforeCall } = {}) => {
    const original = target?.[name];
    if (typeof original !== 'function' || original.__fjkWrapped) return;
    /**
     * The recording wrapper.
     * @param {...unknown} args - Call arguments
     * @returns {unknown} Whatever the original returns
     * @example
     * wrapper('x')
     */
    const wrapper = function recorded(...args) {
      if (busy.has(name)) return original.apply(this, args);
      busy.add(name);
      try {
        const entry = entryFor(typeof label === 'function' ? label(this) : label, this ?? target, args, mapArgs);
        if (!mapResult) emit(entry);
        try {
          beforeCall?.(args);
        } catch {
          // Keep the original arguments.
        }
        const result = original.apply(this, args);
        if (mapResult && entry) {
          if (result && typeof result.then === 'function') {
            result.then((r) => emit({ ...entry, result: mapResult(r) }), () => emit({ ...entry, result: 'error' }));
          } else {
            emit({ ...entry, result: mapResult(result) });
          }
        }
        return result;
      } finally {
        busy.delete(name);
      }
    };
    wrapper.__fjkWrapped = true;
    if (setMethod(target, name, wrapper)) wrapped.push({ target, name, original });
  };

  /**
   * Label a manager method call by the manager's index ("?" = a manager not in the list).
   * @param {string} method - Method name
   * @returns {(self: object) => string} Label function
   * @example
   * vkmLabel('DispatchKeypress')(manager) // "VKM0.DispatchKeypress"
   */
  const vkmLabel = (method) => (self) => {
    const i = getManagers().indexOf(self);
    return `VKM${i < 0 ? '?' : i}.${method}`;
  };

  /**
   * Wrap managers (and their class) that appeared since the last call.
   * @returns {void}
   * @example
   * refresh()
   */
  const refresh = () => {
    for (const manager of getManagers()) {
      const proto = Object.getPrototypeOf(manager);
      for (const method of VKM_METHODS) {
        if (Object.prototype.hasOwnProperty.call(manager, method)) wrap(manager, method, vkmLabel(method));
        if (proto && proto !== Object.prototype && Object.prototype.hasOwnProperty.call(proto, method)) wrap(proto, method, vkmLabel(method));
      }
    }
  };

  refresh();
  wrap(client?.Input, 'ControllerKeyboardSendText', 'Input.ControllerKeyboardSendText');
  // Only whether a modifier or another key moved, never which key (the log must not reveal typing).
  wrap(client?.Input, 'ControllerKeyboardSetKeyState', 'Input.ControllerKeyboardSetKeyState', {
    mapArgs: ([code, down]) => [Number(code) >= 100 && Number(code) <= 103 ? 'mod' : 'key', !!down],
  });
  wrap(client?.Input, 'SetGamepadKeyboardText', 'Input.SetGamepadKeyboardText');
  wrap(client?.OpenVR?.Keyboard, 'SendText', 'OpenVR.Keyboard.SendText');
  wrap(client?.Browser, 'Paste', 'Browser.Paste');

  const context = ibus?._Prototypes?.IBusInputContext;
  const contextProto = typeof context === 'function' && context.prototype ? context.prototype : context;
  if (contextProto) {
    wrap(contextProto, 'process_key_event', 'IBus.process_key_event', {
      mapArgs: ([keyval, , state]) => [describeKeyval(keyval), Number(state) || 0],
      mapResult: (handled) => !!handled,
    });
    for (const method of ['focus_in', 'focus_out', 'reset', 'set_engine']) wrap(contextProto, method, `IBus.${method}`);
    wrap(contextProto, 'connect', 'IBus.connect', {
      mapArgs: ([signal]) => [String(signal)],
      beforeCall: (args) => {
        const [signal, handler] = args;
        if (!IBUS_SIGNALS.has(String(signal)) || typeof handler !== 'function') return;
        /**
         * Record a signal, then run the stock handler.
         * @param {...unknown} a - Signal arguments
         * @returns {unknown} The handler's result
         * @example
         * recordedHandler(text)
         */
        args[1] = function recordedHandler(...a) {
          emit(entryFor(`IBus.signal.${signal}`, this, a, (x) => x.map(describe)));
          return handler.apply(this, a);
        };
      },
    });
  }

  return {
    refresh,
    /**
     * Put every original function back.
     * @returns {void}
     * @example
     * uninstall()
     */
    uninstall: () => {
      for (const { target, name, original } of wrapped.splice(0).reverse()) setMethod(target, name, original);
    },
    get count() {
      return wrapped.length;
    },
  };
};
