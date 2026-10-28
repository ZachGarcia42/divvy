// Grab-pill gesture for bottom sheets. Pure so it can be tested without a device: given how far (px, down is +) and how fast
// (px/ms) the pill was dragged, decide what the sheet does.
export type SheetSnap = 'compact' | 'tall'
export type DragOutcome = 'stay' | 'expand' | 'collapse' | 'dismiss'

const DISTANCE = 80
const FLICK = 0.7

export function dragOutcome({ dy, vy, snap, resizable }: { dy: number; vy: number; snap: SheetSnap; resizable: boolean }): DragOutcome {
  const down = dy > DISTANCE || (dy > 24 && vy > FLICK)
  const up = dy < -DISTANCE || (dy < -24 && vy < -FLICK)
  if (down) return snap === 'tall' && resizable ? 'collapse' : 'dismiss'
  if (up && resizable && snap === 'compact') return 'expand'
  return 'stay'
}

/** How far the panel follows the finger: free downwards, a little upwards when it could still grow, none otherwise. */
export function dragOffset(dy: number, snap: SheetSnap, resizable: boolean): number {
  if (dy >= 0) return dy
  return resizable && snap === 'compact' ? Math.max(dy, -120) : dy / 8
}
