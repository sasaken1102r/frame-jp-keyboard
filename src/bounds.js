// Where our overlay sits inside the stock keyboard popup. Pure logic.
//
// Normally it covers exactly the stock key panel (class "Layout_<name>"): in the 854 x 280 popup that
// is 0..239 px, and the bottom 41 px stay free because SteamVR draws the keyboard's move bar there.
// In buffered mode the stock text line sits above the panel and stays visible. When the stock
// panel's rect is odd (a recreated or resized popup gave top = -97), we fall back to covering the
// popup minus the reserved bottom strip. The result never extends past the popup.

/** Bottom strip of the popup kept free for SteamVR's move bar (measured: 280 - 239). */
export const RESERVED_BOTTOM_PX = 41;
/** Smallest overlay height we accept from the stock panel's rect. */
const MIN_HEIGHT_PX = 120;
/** The stock text line above the panel is never taller than this share of the popup. */
const MAX_TOP_SHARE = 0.4;

/**
 * @typedef {{top: number, bottom: number}} Bounds
 *   Distances in CSS px from the popup's top and bottom edges.
 */

/**
 * Compute the overlay's top and bottom insets.
 * @param {object} input - Measurements
 * @param {number} input.viewportHeight - Popup height (window.innerHeight)
 * @param {{top: number, bottom: number}|null} input.panel - Stock key panel rect, or null when not found
 * @returns {Bounds} Insets from the popup's top and bottom edges
 * @example
 * computeBounds({ viewportHeight: 280, panel: { top: 0, bottom: 239 } }) // { top: 0, bottom: 41 }
 * computeBounds({ viewportHeight: 600, panel: { top: -97, bottom: 400 } }) // { top: 0, bottom: 41 }
 */
export const computeBounds = ({ viewportHeight, panel }) => {
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  if (height === 0) return { top: 0, bottom: 0 };
  const reserved = Math.min(RESERVED_BOTTOM_PX, Math.floor(height / 4));
  const fallback = { top: 0, bottom: reserved };
  if (!panel || !Number.isFinite(panel.top) || !Number.isFinite(panel.bottom)) return fallback;
  const top = Math.round(panel.top);
  const bottom = Math.max(reserved, Math.round(height - panel.bottom));
  const odd = top < 0
    || panel.bottom > height
    || top > height * MAX_TOP_SHARE
    || height - top - bottom < Math.min(MIN_HEIGHT_PX, height - reserved);
  return odd ? fallback : { top, bottom };
};
