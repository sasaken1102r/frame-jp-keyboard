// Console logging with the [fjk] prefix. The injector forwards these lines to journald.

/**
 * Log an info line.
 * @param {...unknown} args - Values to log
 * @returns {void}
 * @example
 * log('installed', '0.1.0')
 */
export const log = (...args) => console.log('[fjk]', ...args);

/**
 * Log a warning line.
 * @param {...unknown} args - Values to log
 * @returns {void}
 * @example
 * warn('popup not found')
 */
export const warn = (...args) => console.warn('[fjk]', ...args);
