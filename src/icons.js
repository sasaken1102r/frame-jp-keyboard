// Line icons for action keys. Font glyphs such as ↶ and ⌫ render tiny in the headset's fonts even
// at a large font-size, so these keys draw their own SVG, sized by CSS (.fjk-icon).
// Drawn for this project (24x24 grid, stroked with currentColor); not taken from an icon set.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Stroke paths per action id. */
const ICON_PATHS = Object.freeze({
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  backspace: ['M21 5H9l-7 7 7 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z', 'M12 9l6 6', 'M18 9l-6 6'],
  // Hide the keyboard: a keyboard with a chevron pointing down (like Android's "hide keyboard").
  close: ['M3 3h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M6 7h1', 'M10 7h1', 'M14 7h1', 'M18 7h1', 'M8 10.5h8', 'M8 17.5l4 3.5 4-3.5'],
  // Clipboard buttons of the kana bar: scissors, two sheets, a clipboard.
  cut: ['M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M21 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M8.2 15.8 18 3', 'M15.8 15.8 6 3'],
  copy: ['M10 8h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M6 16H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1'],
  paste: ['M8 4H6a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-2', 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', 'M9 12h6', 'M9 16h6'],
});

/**
 * Whether an action key has an SVG icon.
 * @param {string} id - Action id
 * @returns {boolean} True when createIcon() can draw it
 * @example
 * hasIcon('backspace') // true
 */
export const hasIcon = (id) => Object.hasOwn(ICON_PATHS, id);

/**
 * Create the SVG icon for an action key in the given document.
 * @param {Document} doc - Owner document (the popup's)
 * @param {string} id - Action id with an icon
 * @returns {SVGSVGElement} The icon element
 * @example
 * keyEl.append(createIcon(doc, 'undo'))
 */
export const createIcon = (doc, id) => {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `fjk-icon fjk-icon-${id}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[id]) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
};
