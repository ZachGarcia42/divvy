// Activity feed (read side): paging state, day grouping, and the words and tap target for each row.
// The server builds each entry (who, what, how much, when); everything here is presentation and paging.
import { feedAmountText, feedSentence, feedTone, type FeedChange, type FeedEntry, type FeedPage, type FeedTone } from '@divvy/domain'
import { dateHeading } from './view'

export type { FeedEntry, FeedPage, FeedTone }

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
}

export const emptyFeed: FeedState = { items: [], nextCursor: null, loading: false, loadingMore: false, loaded: false, error: null }

export const PAGE_SIZE = 30

export function feedPath(groupId: string | null, cursor: string | null, limit = PAGE_SIZE): string {
  const query = [`limit=${limit}`, ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join('&')
  return `${groupId ? `/api/groups/${encodeURIComponent(groupId)}/feed` : '/api/feed'}?${query}`
}

/** A page was requested. The first page keeps what is on screen (no flash) while it reloads. */
export function feedRequested(state: FeedState, more: boolean): FeedState {
  return more ? { ...state, loadingMore: true, error: null } : { ...state, loading: true, error: null }
}

/** A page arrived. The first page replaces the list; later pages append, skipping anything already shown. */
export function feedArrived(state: FeedState, page: FeedPage, more: boolean): FeedState {
  const kept = more ? state.items : []
  const seen = new Set(kept.map((item) => item.id))
  const items = [...kept, ...page.items.filter((item) => !seen.has(item.id))]
  return { items, nextCursor: page.nextCursor, loading: false, loadingMore: false, loaded: true, error: null }
}

export function feedFailed(state: FeedState, message: string): FeedState {
  return { ...state, loading: false, loadingMore: false, error: message }
}

/** There is another page to ask for, and nothing is in flight. */
export const canLoadMore = (state: FeedState) => state.nextCursor !== null && !state.loading && !state.loadingMore

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

/** Entries are already newest first; this only cuts them into days with a heading ("TODAY · NOV 2"). */
export function groupFeedByDay(items: FeedEntry[], todayIso: string, offsetMinutes?: number) {
  const out: { day: string; heading: string; items: FeedEntry[] }[] = []
  for (const item of items) {
    const day = localDay(item.at, offsetMinutes)
    const last = out[out.length - 1]
    if (last && last.day === day) last.items.push(item)
    else out.push({ day, heading: day ? dateHeading(day, todayIso) : 'EARLIER', items: [item] })
  }
  return out
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

export const TONE_GLYPH: Record<FeedTone, string> = { add: '＋', edit: '✎', delete: '🗑', undo: '↩', settle: '✓', move: '⇄' }

export type FeedRow = {
  id: string
  tone: FeedTone
  glyph: string
  /** "You added “Dinner”" */
  title: string
  /** "$40.00 (was $35.00)" or null */
  amount: string | null
  /** Second line: what changed, or a note on a deleted item. */
  detail: string | null
  /** "3:42 PM", plus the group name on the all-groups feed. */
  meta: string
  /** Whole-row label for screen readers. */
  label: string
  /** Struck through: the thing this row is about no longer counts. */
  struck: boolean
}

export function feedRow(entry: FeedEntry, youId: string | null, opts: { showGroup: boolean; offsetMinutes?: number }): FeedRow {
  const tone = feedTone(entry)
  const title = feedSentence(entry, youId)
  const amount = feedAmountText(entry)
  const detail = entry.kind === 'expense.updated' ? changeSummary(entry.changes) : null
  const time = clockText(entry.at, opts.offsetMinutes)
  const meta = [time, opts.showGroup ? entry.group.name : ''].filter(Boolean).join(' · ')
  const struck = entry.kind === 'expense.deleted' || (entry.target.type === 'settlement' && entry.kind === 'settlement.created' && !entry.target.live)
  return {
    id: entry.id,
    tone,
    glyph: TONE_GLYPH[tone],
    title,
    amount,
    detail,
    meta,
    label: [title, amount, detail, meta].filter(Boolean).join('. '),
    struck,
  }
}

// ─── Tapping a row ───

export type FeedTarget =
  | { kind: 'expense'; groupId: string; expenseId: string }
  | { kind: 'settle'; groupId: string }
  | { kind: 'group'; groupId: string }

/** Where a tap on this row goes: a live expense opens its detail, a payment opens the group's payments, anything else the group. */
export function feedTarget(entry: FeedEntry): FeedTarget {
  const groupId = entry.group.id
  if (entry.target.type === 'settlement') return { kind: 'settle', groupId }
  const movedAway = entry.kind === 'expense.moved' && entry.direction === 'out'
  if (entry.target.id && entry.target.live && !movedAway) return { kind: 'expense', groupId, expenseId: entry.target.id }
  return { kind: 'group', groupId }
}
