// Pure rules of the mobile swipe tabs (SwipeTabs.tsx). [SPEC: vue mobile, onglets à balayage]

/** Horizontal distance, in px, a released swipe must cover to change tab. */
export const SWIPE_THRESHOLD_PX = 60;
/** Movement, in px, after which a gesture is decided horizontal (tab swipe) or vertical (scroll). */
export const SWIPE_SLOP_PX = 10;

/** Axis of a gesture so far, or null while it is still too short to tell. */
export function gestureAxis(dx: number, dy: number, slop = SWIPE_SLOP_PX): 'x' | 'y' | null {
  if (Math.abs(dx) > slop && Math.abs(dx) > Math.abs(dy)) return 'x';
  if (Math.abs(dy) > slop) return 'y';
  return null;
}

/** Tab reached when a horizontal swipe of `dx` px is released on tab `index` of `count`. */
export function swipeTarget(index: number, count: number, dx: number, threshold = SWIPE_THRESHOLD_PX): number {
  if (dx <= -threshold && index < count - 1) return index + 1;
  if (dx >= threshold && index > 0) return index - 1;
  return index;
}

/** Offset shown while dragging: damped past the first and the last tab, where nothing follows. */
export function dragOffset(index: number, count: number, dx: number): number {
  return (index === 0 && dx > 0) || (index === count - 1 && dx < 0) ? dx / 3 : dx;
}
