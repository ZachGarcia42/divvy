// Grab-pill gesture for bottom sheets. Pure so it can be tested without a device: given how far (px, down is +) and how fast
// (px/ms) the pill was dragged, decide what the sheet does.
export type SheetSnap = 'compact' | 'tall'
export type DragOutcome = 'stay' | 'expand' | 'collapse' | 'dismiss'

const DISTANCE = 80
const FLICK = 0.7
/** A flick is fast AND covers some ground, so a quick 40px nudge never counts (px). */
const FLICK_MIN = 60
/** Dismiss when the panel was dragged down past this share of its own height. */
const DISMISS_SHARE = 1 / 3
/** Used when the sheet has not been measured yet (px). */
const FALLBACK_HEIGHT = 300

export function dragOutcome({ dy, vy, snap, resizable, height = FALLBACK_HEIGHT }: { dy: number; vy: number; snap: SheetSnap; resizable: boolean; height?: number }): DragOutcome {
  const flickDown = dy > FLICK_MIN && vy > FLICK
  const flickUp = dy < -24 && vy < -FLICK
  const up = dy < -DISTANCE || flickUp
  // From the tall snap a long drag (or a flick) only shrinks the sheet back to compact; it never closes it in one go.
  if (snap === 'tall' && resizable) { if (dy > DISTANCE || flickDown) return 'collapse'; return 'stay' }
  // Otherwise the sheet closes only when dragged past a third of its height, or flicked down.
  if (dy > Math.max(height, 1) * DISMISS_SHARE || flickDown) return 'dismiss'
  if (up && resizable && snap === 'compact') return 'expand'
  return 'stay'
}

/** How far the panel follows the finger: free downwards, a little upwards when it could still grow, none otherwise. */
export function dragOffset(dy: number, snap: SheetSnap, resizable: boolean): number {
  if (dy >= 0) return dy
  return resizable && snap === 'compact' ? Math.max(dy, -120) : dy / 8
}
