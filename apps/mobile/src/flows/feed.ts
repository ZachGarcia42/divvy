// Activity feed (read side): paging state, day grouping, and the words and tap target for each row.
// The server builds each entry (who, what, how much, when); everything here is presentation and paging.
import { feedPaymentDetail, feedSegments, feedSentence, feedTone, formatMoney, type FeedChange, type FeedEntry, type FeedPage, type FeedSegment, type FeedTone } from '@divvy/domain'
import { dateHeading, groupIcon, weekdayMonthDay } from './view'

export type { FeedEntry, FeedPage, FeedSegment, FeedTone }

// ─── Paging state ───

export type FeedState = {
  items: FeedEntry[]
  nextCursor: string | null
  /** First page requested and not back yet. */
  loading: boolean
  /** A later page requested and not back yet. */
  loadingMore: boolean
  /** The first page has come back at least once. */
  loaded: boolean
  error: string | null
  /** The failed request was for a later page (the list on screen is still good). */
  errorMore: boolean
}

export const emptyFeed: FeedState = { items: [], nextCursor: null, loading: false, loadingMore: false, loaded: false, error: null, errorMore: false }

export const PAGE_SIZE = 30

export function feedPath(groupId: string | null, cursor: string | null, limit = PAGE_SIZE): string {
  const query = [`limit=${limit}`, ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join('&')
  return `${groupId ? `/api/groups/${encodeURIComponent(groupId)}/feed` : '/api/feed'}?${query}`
}

/** A page was requested. The first page keeps what is on screen (no flash) while it reloads. */
export function feedRequested(state: FeedState, more: boolean): FeedState {
  return more ? { ...state, loadingMore: true, error: null, errorMore: false } : { ...state, loading: true, error: null, errorMore: false }
}

/** A page arrived. The first page replaces the list; later pages append, skipping anything already shown. */
export function feedArrived(state: FeedState, page: FeedPage, more: boolean): FeedState {
  const kept = more ? state.items : []
  const seen = new Set(kept.map((item) => item.id))
  const items = [...kept, ...page.items.filter((item) => !seen.has(item.id))]
  return { items, nextCursor: page.nextCursor, loading: false, loadingMore: false, loaded: true, error: null, errorMore: false }
}

/**
 * The newest page came back while older pages are already loaded (returning to the feed, pull to refresh): put the new rows on top
 * and keep what was loaded below, with its cursor. When the new page does not reach back to what was shown (a lot happened in
 * between), or it is the whole feed, it replaces the list instead so there is never a gap.
 */
export function feedRefreshed(state: FeedState, page: FeedPage): FeedState {
  const shown = new Set(state.items.map((item) => item.id))
  const overlaps = page.items.some((item) => shown.has(item.id))
  if (state.items.length === 0 || page.nextCursor === null || !overlaps) return feedArrived(state, page, false)
  const fresh = new Set(page.items.map((item) => item.id))
  const items = [...page.items, ...state.items.filter((item) => !fresh.has(item.id))]
  return { items, nextCursor: state.nextCursor, loading: false, loadingMore: false, loaded: true, error: null, errorMore: false }
}

export function feedFailed(state: FeedState, message: string, more = false): FeedState {
  return { ...state, loading: false, loadingMore: false, error: message, errorMore: more }
}

/** There is another page to ask for, and nothing is in flight. */
export const canLoadMore = (state: FeedState) => state.nextCursor !== null && !state.loading && !state.loadingMore

/** Scrolling to within this many px of the bottom asks for the next page. */
export const LOAD_AHEAD_PX = 400

/**
 * Whether scrolling (or a short list that does not fill the screen) should ask for the next page by itself. Never after an error:
 * the user retries with the snackbar or "Show older", so a failing request is not hammered on every scroll event.
 */
export function shouldAutoLoad(state: FeedState, distanceFromBottom: number): boolean {
  return canLoadMore(state) && state.error === null && distanceFromBottom < LOAD_AHEAD_PX
}

/** What the snackbar over the list says, when a request failed but a list is on screen to keep. Null otherwise. */
export function feedSnack(state: FeedState): { text: string; action: string } | null {
  if (state.error === null || state.items.length === 0) return null
  return { text: state.errorMore ? 'Couldn’t load older activity' : 'Couldn’t refresh activity', action: 'Retry' }
}

/** What goes on screen: skeleton rows, the friendly error, the empty state, or the list. */
export function feedView(state: FeedState): 'loading' | 'error' | 'empty' | 'list' {
  if (state.items.length > 0) return 'list'
  if (state.error !== null) return 'error'
  if (state.loaded) return 'empty'
  return 'loading'
}

// ─── Back to the feed ───

/**
 * Where a row was opened from. Opening an expense or Settle up from the feed pushes it on top of the feed (nothing is replaced):
 * `screen` is the feed it came from, `y` its scroll offset, `at` the screen the row opened.
 */
export type FeedOrigin = { screen: 'activity' | 'groupActivity'; y: number; at: 'expense' | 'settle' | 'deleted' | 'group' }

/** Back from `screen` goes to the feed it was opened from. */
export const returnsToFeed = (origin: FeedOrigin | null, screen: string): origin is FeedOrigin => origin !== null && origin.at === screen

/**
 * The origin stays valid while the user is on the screen the row opened. A row that opened the group keeps it through that group's
 * own expense, Settle up and Activity screens, so back from the group still lands on the feed. Anywhere else it is forgotten.
 */
export function originStays(origin: FeedOrigin, screen: string): boolean {
  if (screen === origin.at) return true
  return origin.at === 'group' && (screen === 'expense' || screen === 'settle' || screen === 'groupActivity')
}

// ─── Day grouping ───

const pad = (n: number) => String(n).padStart(2, '0')

/** The calendar day an entry happened on, in the viewer's zone (offset in minutes east of UTC; defaults to this device). */
export function localDay(at: string, offsetMinutes?: number): string {
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  const shifted = new Date(ms + (offsetMinutes ?? -new Date(ms).getTimezoneOffset()) * 60_000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** "3:42 PM" in the viewer's zone. */
export function clockText(at: string, offsetMinutes?: number): string {
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  const shifted = new Date(ms + (offsetMinutes ?? -new Date(ms).getTimezoneOffset()) * 60_000)
  const h = shifted.getUTCHours()
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(shifted.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`
}

/** "FRI · OCT 30", with the year added only when it is not this year ("FRI · DEC 12, 2025"). */
function headingWithYear(day: string, todayIso: string) {
  const heading = dateHeading(day, todayIso)
  return day.slice(0, 4) === todayIso.slice(0, 4) ? heading : `${heading}, ${day.slice(0, 4)}`
}

/** Entries are already newest first; this only cuts them into days with a heading ("TODAY · NOV 2"). */
export function groupFeedByDay(items: FeedEntry[], todayIso: string, offsetMinutes?: number) {
  const out: { day: string; heading: string; items: FeedEntry[] }[] = []
  for (const item of items) {
    const day = localDay(item.at, offsetMinutes)
    const last = out[out.length - 1]
    if (last && last.day === day) last.items.push(item)
    else out.push({ day, heading: day ? headingWithYear(day, todayIso) : 'EARLIER', items: [item] })
  }
  return out
}

// ─── Split by group ───

/** Entries each group section carries from the server (`?per=`) before "Show N more". */
export const SECTION_ROWS = 4

export const sectionsPath = (per = SECTION_ROWS) => `/api/feed/sections?per=${per}`

/** One group's slice of the All view, as the server sends it: the group's newest entries and how many it has in all. */
export type SectionData = { group: FeedEntry['group']; total: number; items: FeedEntry[] }

/** `flat`: the server's answer had no usable sections (an older server, or a reply without the array), so the All view shows the plain newest-first feed instead of going blank. */
export type SectionsState = { sections: SectionData[]; loading: boolean; loaded: boolean; error: string | null; flat?: boolean }
export const emptySections: SectionsState = { sections: [], loading: false, loaded: false, error: null }
/** Requested: what is on screen stays (no flash) while it reloads. */
export const sectionsRequested = (state: SectionsState): SectionsState => ({ ...state, loading: true, error: null })
export function sectionsArrived(page: { sections?: unknown } | null | undefined): SectionsState {
  const raw = page?.sections
  if (!Array.isArray(raw)) return { sections: [], loading: false, loaded: true, error: null, flat: true }
  // A section without a group is unusable; one without a list of entries is shown empty rather than crashing the screen.
  const sections = raw
    .filter((section): section is SectionData => !!section && typeof section === 'object' && !!(section as SectionData).group && typeof (section as SectionData).group.id === 'string')
    .map((section) => ({ ...section, items: Array.isArray(section.items) ? section.items : [], total: typeof section.total === 'number' ? section.total : Array.isArray(section.items) ? section.items.length : 0 }))
  return { sections, loading: false, loaded: true, error: null }
}
export const sectionsFailed = (state: SectionsState, message: string): SectionsState => ({ ...state, loading: false, error: message })

/** The All view as a FeedState, so it shares the loading, error and empty screens (and the refresh snackbar) with the other feeds. It never has a next page: every group is already there. */
export function sectionsAsFeed(state: SectionsState): FeedState {
  return { items: state.sections.flatMap((section) => section.items), nextCursor: null, loading: state.loading && !state.loaded, loadingMore: false, loaded: state.loaded, error: state.error, errorMore: false }
}

export type FeedSection = {
  group: FeedEntry['group']
  /** Every entry the group has in the feed (the server's count), loaded or not. */
  total: number
  /** The ones on screen: the newest few, or everything loaded when the section is open. */
  shown: FeedEntry[]
  /** How many entries are not on screen yet: what "Show N more" says. */
  hidden: number
  expanded: boolean
  /** The next batch is on its way. */
  loadingMore: boolean
  /** The last request for this section's entries failed. */
  failed: boolean
}

/**
 * The sections on screen. The server sends one per group with activity, latest first, each with its newest entries and its total, so
 * the order and the counts do not depend on how busy any one group is. An open section shows its group's own feed as far as it has
 * been loaded (`pages`), which starts with the same newest entries.
 */
export function buildSections(data: SectionData[], pages: Record<string, FeedState> = {}, open: Record<string, boolean> = {}): FeedSection[] {
  return data.map((section) => {
    const id = section.group.id
    const page = pages[id]
    const expanded = !!open[id]
    const loadedAll = expanded && !!page?.loaded && page.items.length >= section.items.length
    const shown = loadedAll ? page!.items : section.items
    // Once a whole group has been read, its own list is the truth even if the count was a moment out of date.
    const exhausted = loadedAll && page!.nextCursor === null
    return {
      group: section.group,
      total: section.total,
      shown,
      hidden: exhausted ? 0 : Math.max(0, section.total - shown.length),
      expanded,
      loadingMore: expanded && !!page && (page.loadingMore || (page.loading && !page.loaded)),
      failed: expanded && !!page && page.error !== null,
    }
  })
}

export type FeedChip = { id: string | null; emoji: string; title: string; label: string }

/**
 * The filter chips: "All", then each group, the ones with the latest activity first (the same order as the sections), then the rest
 * as the groups list has them. An archived group only has a chip while it still has activity.
 */
export function feedChips(groups: { id: string; name: string; emoji?: string | null; archived?: boolean }[], recent: FeedEntry['group'][]): FeedChip[] {
  const recentIds = recent.map((group) => group.id)
  const known = new Map(groups.map((group) => [group.id, group]))
  const rank = (id: string) => { const at = recentIds.indexOf(id); return at === -1 ? recentIds.length : at }
  const chosen = groups.filter((group) => !group.archived || recentIds.includes(group.id))
  const ordered = chosen.map((group, index) => ({ group, index })).sort((a, b) => rank(a.group.id) - rank(b.group.id) || a.index - b.index).map((entry) => entry.group)
  const chipOf = (group: { id: string; name: string; emoji?: string | null }): FeedChip => {
    const icon = groupIcon(group)
    return { id: group.id, emoji: icon.emoji, title: icon.title, label: [icon.emoji, icon.title].filter(Boolean).join(' ') }
  }
  const chips = ordered.map(chipOf)
  // A group with activity that the list has not caught up with yet still gets its section's chip.
  for (const group of recent) {
    if (!known.has(group.id)) chips.splice(Math.min(recentIds.indexOf(group.id), chips.length), 0, chipOf(group))
  }
  return [{ id: null, emoji: '', title: 'All', label: 'All' }, ...chips]
}

/** The chip to show as picked: the filter when that group is still one of the chips, else All. */
export const activeChip = (chips: FeedChip[], filter: string | null): string | null => (filter !== null && chips.some((chip) => chip.id === filter) ? filter : null)

/** "Today", "Yesterday", else "Fri, Oct 30" (with the year when it is not this year): the day on a row that no day heading sits above. */
export function dayLabel(at: string, todayIso: string, offsetMinutes?: number): string {
  const day = localDay(at, offsetMinutes)
  if (!day) return ''
  const gap = Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000)
  if (gap === 0) return 'Today'
  if (gap === 1) return 'Yesterday'
  return `${weekdayMonthDay(day)}${day.slice(0, 4) === todayIso.slice(0, 4) ? '' : `, ${day.slice(0, 4)}`}`
}

// ─── One row ───

const FIELD_WORDS: Record<string, string> = {
  amount: 'amount', description: 'name', date: 'date', category: 'category', payer: 'who paid', method: 'split type', split: 'split',
}

/** "Changed the amount and date", or null when the edit did not record what changed. */
export function changeSummary(changes: FeedChange[] | null): string | null {
  if (!changes || changes.length === 0) return null
  const words = [...new Set(changes.map((change) => FIELD_WORDS[change.field] ?? change.field))]
  const list = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return `Changed the ${list}`
}

/** Ionicons line icons, one per tone. Never emoji. */
export const TONE_ICON: Record<FeedTone, string> = { add: 'add', edit: 'pencil', delete: 'trash-outline', undo: 'arrow-undo', settle: 'checkmark', move: 'swap-horizontal', photo: 'camera-outline' }

export type FeedRow = {
  id: string
  tone: FeedTone
  icon: string
  /** "You added “Dinner”" as heavy and regular pieces. */
  segments: FeedSegment[]
  /** The same sentence as plain text. */
  title: string
  /** "$40.00" or null */
  amount: string | null
  /** "was $35.00" under the amount of an edit that changed it, or null. */
  previousAmount: string | null
  /** "€40.00" under the amount of an expense entered in another currency (the amount above is the converted one), or null. */
  originalAmount: string | null
  /** Lines under the sentence: what changed, who paid whom, “Dated Sat, Oct 24”. */
  details: string[]
  /** "3:42 PM", plus the day ("Yesterday · 3:42 PM") when no day heading sits above the row, plus the group when it is not in a group's section. */
  meta: string
  /** Whole-row label for screen readers. */
  label: string
  /** The quoted name is struck through (a deleted expense). */
  struckLabel: boolean
  /** The amount is struck through: the thing no longer counts. */
  struckAmount: boolean
}

/** "Dated Sat, Oct 24" when an added or edited expense carries a different date than the day it was logged (device zone); else null. */
export function datedLine(entry: FeedEntry, todayIso?: string, offsetMinutes?: number): string | null {
  if (entry.kind !== 'expense.created' && entry.kind !== 'expense.updated') return null
  const date = entry.expenseDate
  if (!date || date === localDay(entry.at, offsetMinutes)) return null
  const year = todayIso && date.slice(0, 4) !== todayIso.slice(0, 4) ? `, ${date.slice(0, 4)}` : ''
  return `Dated ${weekdayMonthDay(date)}${year}`
}

export function feedRow(entry: FeedEntry, youId: string | null, opts: { showGroup: boolean; showDay?: boolean; offsetMinutes?: number; today?: string }): FeedRow {
  const tone = feedTone(entry)
  const title = feedSentence(entry, youId)
  const amount = entry.amountMinor === null ? null : formatMoney(entry.amountMinor, entry.currency)
  const previousAmount = entry.kind === 'expense.updated' && entry.previousAmountMinor !== null ? `was ${formatMoney(entry.previousAmountMinor, entry.currency)}` : null
  const originalAmount = entry.originalMinor !== null && entry.originalCurrency !== null ? formatMoney(entry.originalMinor, entry.originalCurrency) : null
  const details = [
    entry.kind === 'expense.updated' ? changeSummary(entry.changes) : null,
    feedPaymentDetail(entry, youId),
    datedLine(entry, opts.today, opts.offsetMinutes),
  ].filter((line): line is string => !!line)
  const time = clockText(entry.at, opts.offsetMinutes)
  const groupText = opts.showGroup ? [entry.group.emoji, entry.group.name].filter(Boolean).join(' ') : ''
  const dayText = opts.showDay && opts.today ? dayLabel(entry.at, opts.today, opts.offsetMinutes) : ''
  const meta = [dayText, time, groupText].filter(Boolean).join(' · ')
  const struckLabel = entry.kind === 'expense.deleted'
  const struckAmount = struckLabel || (entry.kind === 'settlement.created' && !entry.target.live)
  return {
    id: entry.id,
    tone,
    icon: TONE_ICON[tone],
    segments: feedSegments(entry, youId),
    title,
    amount,
    previousAmount,
    originalAmount,
    details,
    meta,
    label: [title, amount, originalAmount ? `entered as ${originalAmount}` : null, previousAmount, ...details, meta].filter(Boolean).join('. '),
    struckLabel,
    struckAmount,
  }
}

// ─── Tapping a row ───

export type FeedTarget =
  | { kind: 'expense'; groupId: string; expenseId: string }
  | { kind: 'settle'; groupId: string }
  | { kind: 'deleted'; groupId: string; expenseId: string }
  | { kind: 'group'; groupId: string }

/**
 * Where a tap on this row goes: a live expense opens its detail, a deleted one a read-only detail with Restore, a payment the
 * group's payments, anything else the group.
 */
export function feedTarget(entry: FeedEntry): FeedTarget {
  const groupId = entry.group.id
  if (entry.target.type === 'settlement') return { kind: 'settle', groupId }
  const movedAway = entry.kind === 'expense.moved' && entry.direction === 'out'
  if (entry.target.id && entry.target.live && !movedAway) return { kind: 'expense', groupId, expenseId: entry.target.id }
  if (entry.target.id && !entry.target.live && !movedAway) return { kind: 'deleted', groupId, expenseId: entry.target.id }
  return { kind: 'group', groupId }
}
