// Web-only helpers kept pure so they can be unit-tested without a browser.

/** The landing pages link into the web app under /app/...; map that back to the paths parseDeepLink knows. */
export function webLinkUrl(href: string | null | undefined) {
  if (!href) return null
  const match = href.match(/^(https?:\/\/[^/]+)\/app(\/(?:login|invite)\b.*)$/i)
  return match ? `${match[1]}${match[2]}` : href
}

/** Same origin on web (the API serves the app); a native build keeps EXPO_PUBLIC_API_URL. */
export function apiBase(os: string, env: { api?: string; webApi?: string }) {
  if (os === 'web') return (env.webApi ?? '').replace(/\/+$/, '')
  return env.api ?? 'http://localhost:8787'
}

/** sha256 hex of the raw nonce: Google gets this, the API gets the raw value. */
export async function sha256Hex(value: string, subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> }) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** One shared width for the sign-in column: the Google button is rendered at this width and app buttons/fields stretch to it. */
export const SIGN_IN_WIDTH = 320

/**
 * Browser Back inside the single-page app. The app has no URL routes, so one Back would leave the site. While anything other
 * than a bare Groups screen is showing, the page keeps one history entry per step Back would take (`backDepth`): popping an entry
 * steps back inside the app exactly as the Android hardware button does, and Back from the bare Groups screen leaves the site.
 * Each entry's state carries a snapshot of the screen it was pushed for, so Forward can bring that screen back.
 */
export type NavLite = {
  screen: string
  /** Where a feed row was opened from (see FeedOrigin): `at` is the screen it opened, `screen` the feed Back returns to. */
  origin: { at: string; screen: string } | null
  /** The Activity view is narrowed to one group by "See all": Back clears the filter before it leaves Activity. */
  seeAll: boolean
  editingPay: boolean
  /** A sheet is open (add expense, create group, switch group, your name). */
  overlay: boolean
}

/** One step of Back, as a pure mirror of the app's stepBack; null when there is nothing left to step out of. */
export function stepBackLite(n: NavLite): NavLite | null {
  if (n.overlay) return { ...n, overlay: false }
  if (n.editingPay) return { ...n, editingPay: false }
  if (n.screen === 'activity' && n.seeAll) return { ...n, seeAll: false }
  if (n.origin && n.origin.at === n.screen) return { ...n, screen: n.origin.screen, origin: null }
  if (n.screen === 'expense' || n.screen === 'settle' || n.screen === 'groupActivity') return { ...n, screen: 'group' }
  if (n.screen === 'group' || n.screen === 'account' || n.screen === 'activity' || n.screen === 'deleted') return { ...n, screen: 'groups', origin: null, seeAll: false }
  return null
}

/** How many Backs it takes to get from this state to the bare Groups screen: the number of history entries to keep above the page. */
export function backDepth(n: NavLite): number {
  let depth = 0
  let at: NavLite | null = n
  while (at && depth < 12) {
    at = stepBackLite(at)
    if (at) depth += 1
  }
  return depth
}

/** What to do to the browser history so that it holds `want` entries above the page when it holds `pos` now. */
export type HistoryMove = { push: number } | { back: number } | null
export function historyMove(pos: number, want: number): HistoryMove {
  if (want > pos) return { push: want - pos }
  if (want < pos) return { back: pos - want }
  return null
}
