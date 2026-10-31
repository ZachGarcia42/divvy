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

/** One pointer position (px, down is +, relative to where the drag began) and when it was seen (ms, a monotonic clock). */
export type DragSample = { t: number; y: number }
/** Speed is measured over this much of the end of the drag (ms), and a pointer that sat still this long is not flicking (ms). */
const VELOCITY_WINDOW = 150
const VELOCITY_STALE = 100

/**
 * Vertical speed (px/ms, down is +) at release, from the recent move samples. Times should be when the pointer events happened
 * (their own timestamps), so a slow frame between handling a move and the release does not stretch the gesture or read as a pause.
 * react-native-web's own `gestureState.vy` is only the last move's delta over the gap since the previous move, and for the
 * first move of a drag that gap runs from time 0 (not from the pointer-down), so a one-step flick reads ~0 px/ms and a
 * many-step one depends on whichever gap came last. A window over the last ~150ms is steady against both.
 */
export function releaseVelocity(samples: readonly DragSample[], now: number): number {
  const n = samples.length
  if (n < 2) return 0
  const last = samples[n - 1]
  if (now - last.t > VELOCITY_STALE) return 0
  let i = n - 1
  while (i > 0 && last.t - samples[i - 1].t <= VELOCITY_WINDOW) i--
  const from = samples[i === n - 1 ? n - 2 : i]
  return (last.y - from.y) / Math.max(last.t - from.t, 1)
}

/** How far the panel follows the finger: free downwards, a little upwards when it could still grow, none otherwise. */
export function dragOffset(dy: number, snap: SheetSnap, resizable: boolean): number {
  if (dy >= 0) return dy
  return resizable && snap === 'compact' ? Math.max(dy, -120) : dy / 8
}

/** How far a sheet lifts to clear the on-screen keyboard (px). The web browser lifts its own page, so there it is 0; a bad height is 0. */
export function keyboardLift(height: number, os: string): number {
  if (os === 'web') return 0
  return Number.isFinite(height) && height > 0 ? Math.round(height) : 0
}
