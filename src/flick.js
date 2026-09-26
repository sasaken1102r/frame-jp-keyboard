// Flick direction detection. Pure logic, no DOM.

/** Distance in CSS px the pointer must travel before a press counts as a flick. */
export const DEFAULT_FLICK_THRESHOLD = 24;

/** All directions, in the order used by the kana table: tap, left, up, right, down. */
export const DIRECTIONS = Object.freeze(['center', 'left', 'up', 'right', 'down']);

/**
 * Classify a pointer movement as a tap or one of four flick directions.
 * The movement is measured from the touchstart point. Below the threshold it is a tap
 * ("center"); above it the direction is chosen by angle in 90-degree sectors, so a
 * slanted flick still resolves to the nearest axis.
 * @param {number} dx - Horizontal movement in CSS px (positive = right)
 * @param {number} dy - Vertical movement in CSS px (positive = down, screen coordinates)
 * @param {number} [threshold=DEFAULT_FLICK_THRESHOLD] - Minimum distance for a flick
 * @returns {'center'|'left'|'up'|'right'|'down'} The detected direction
 * @example
 * getFlickDirection(103, -5) // "right"
 * getFlickDirection(-3, -53) // "up"
 * getFlickDirection(6, 9) // "center"
 */
export const getFlickDirection = (dx, dy, threshold = DEFAULT_FLICK_THRESHOLD) => {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'center';
  if (Math.hypot(dx, dy) < threshold) return 'center';
  // atan2 with -dy so that 90 degrees points up on screen.
  const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (angle >= -45 && angle < 45) return 'right';
  if (angle >= 45 && angle < 135) return 'up';
  if (angle >= -135 && angle < -45) return 'down';
  return 'left';
};
