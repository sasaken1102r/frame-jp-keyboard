// Kana-kanji conversion served by the injector (Python + libanthy) through a CDP binding.
//
// The injector adds the binding `fjkAnthy` to SharedJSContext (Runtime.addBinding). We call it with
// a JSON request carrying an id; the injector answers by evaluating `__fjkAnthyReply(reply)`. Every
// request is self-contained (the reading and the segment lengths), so the injector keeps no state
// for us and previews can never disturb an explicit conversion. Only `commit` and
// `commitPrediction` make anthy learn. No IBus is involved, so the stock keyboard's IBus state is
// never touched.

/** Name of the binding the injector installs. */
export const BINDING_NAME = 'fjkAnthy';
/** Global function the injector calls with replies. */
export const REPLY_NAME = '__fjkAnthyReply';

/**
 * @typedef {{reading: string, candidates: string[]}} Segment
 */

/**
 * @typedef {object} ConversionBackend
 * @property {(reading: string, lengths?: number[]) => Promise<Segment[]>} convert - Convert a reading (optionally with segment lengths)
 * @property {(reading: string, lengths: number[], index: number, delta: number) => Promise<Segment[]>} resize - Resize one segment by ±1
 * @property {(reading: string) => Promise<string[]>} predict - Predictions (learned history)
 * @property {(c: {reading: string, lengths: number[], choices: number[], texts: string[]}) => Promise<boolean>} commit - Learn a conversion
 * @property {(p: {reading: string, index: number, text: string}) => Promise<boolean>} commitPrediction - Learn a picked prediction
 */

/**
 * Create the client.
 * @param {object} [options] - Options
 * @param {(...args: unknown[]) => void} [options.warn] - Warning logger
 * @param {number} [options.timeoutMs=4000] - Give up on a request after this long
 * @param {object} [options.scope=globalThis] - Where the binding and the reply function live (tests)
 * @param {() => number} [options.now] - Clock in ms
 * @returns {ConversionBackend & {init: () => Promise<boolean>, destroy: () => void, readonly info: object}} The client
 * @example
 * const anthy = createAnthyClient();
 * if (await anthy.init()) console.log(await anthy.convert('かんじ'));
 */
export const createAnthyClient = ({ warn = () => {}, timeoutMs = 4000, scope = globalThis, now = () => performance.now() } = {}) => {
  let nextId = 1;
  /** @type {Map<number, {resolve: Function, reject: Function, timer: unknown, started: number, op: string}>} */
  const pending = new Map();
  const stats = { requests: 0, failures: 0, lastRttMs: 0, maxRttMs: 0, rtts: [] };

  /**
   * Handle a reply from the injector.
   * @param {{id: number, ok: boolean, error?: string}} reply - Reply
   * @returns {void}
   * @example
   * onReply({ id: 1, ok: true, segments: [] })
   */
  const onReply = (reply) => {
    const entry = pending.get(reply?.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    const rtt = now() - entry.started;
    stats.lastRttMs = rtt;
    stats.maxRttMs = Math.max(stats.maxRttMs, rtt);
    stats.rtts = [...stats.rtts, Math.round(rtt * 10) / 10].slice(-50);
    if (reply.error) {
      stats.failures += 1;
      entry.reject(new Error(`anthy ${entry.op} failed: ${reply.error}`));
    } else {
      entry.resolve(reply);
    }
  };
  scope[REPLY_NAME] = onReply;

  /**
   * Send one request to the injector.
   * @param {string} op - Operation
   * @param {object} [payload] - Request fields
   * @returns {Promise<any>} The reply
   * @example
   * await request('convert', { reading: 'かんじ' })
   */
  const request = (op, payload = {}) => new Promise((resolve, reject) => {
    const binding = scope[BINDING_NAME];
    if (typeof binding !== 'function') {
      reject(new Error('anthy backend not available (injector binding missing)'));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      stats.failures += 1;
      reject(new Error(`anthy ${op} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, started: now(), op });
    stats.requests += 1;
    try {
      binding(JSON.stringify({ id, op, ...payload }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });

  return {
    /**
     * Check that the injector serves conversions.
     * @returns {Promise<boolean>} True when available
     * @example
     * await init()
     */
    init: async () => {
      try {
        const reply = await request('hello');
        return !!reply.ok;
      } catch (error) {
        warn(`${error?.message ?? error}`);
        return false;
      }
    },
    /**
     * Convert a reading.
     * @param {string} reading - Hiragana reading
     * @param {number[]} [lengths] - Segment lengths to restore (from an earlier conversion)
     * @returns {Promise<Segment[]>} Segments
     * @example
     * await convert('きょうはいいてんき')
     */
    convert: async (reading, lengths) => (await request('convert', { reading, lengths })).segments,
    /**
     * Resize one segment by one character.
     * @param {string} reading - Reading
     * @param {number[]} lengths - Current segment lengths
     * @param {number} index - Segment to resize
     * @param {number} delta - -1 (shorter) or +1 (longer)
     * @returns {Promise<Segment[]>} New segments
     * @example
     * await resize('きょうはいいてんき', [3, 3, 3], 0, 1)
     */
    resize: async (reading, lengths, index, delta) => (await request('resize', { reading, lengths, index, delta })).segments,
    /**
     * Predictions for a reading.
     * @param {string} reading - Reading
     * @returns {Promise<string[]>} Predictions
     * @example
     * await predict('てん')
     */
    predict: async (reading) => (await request('predict', { reading })).predictions ?? [],
    /**
     * Learn a committed conversion.
     * @param {{reading: string, lengths: number[], choices: number[], texts: string[]}} conversion - What was committed
     * @returns {Promise<boolean>} True when anthy learned it
     * @example
     * await commit({ reading: 'きかい', lengths: [3], choices: [2], texts: ['器械'] })
     */
    commit: async (conversion) => !!(await request('commit', conversion)).ok,
    /**
     * Learn a picked prediction.
     * @param {{reading: string, index: number, text: string}} prediction - What was picked
     * @returns {Promise<boolean>} True when anthy learned it
     * @example
     * await commitPrediction({ reading: 'てん', index: 0, text: '天気' })
     */
    commitPrediction: async (prediction) => !!(await request('commitPrediction', prediction)).ok,
    /**
     * Stop listening for replies (pending requests fail).
     * @returns {void}
     * @example
     * destroy()
     */
    destroy: () => {
      if (scope[REPLY_NAME] === onReply) delete scope[REPLY_NAME];
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('anthy client destroyed'));
        pending.delete(id);
      }
    },
    get info() {
      return { ...stats, rtts: [...stats.rtts], pending: pending.size, available: typeof scope[BINDING_NAME] === 'function' };
    },
  };
};
