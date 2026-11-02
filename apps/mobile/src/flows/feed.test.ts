import { describe, expect, it } from 'vitest'
import {
  PAGE_SIZE, LOAD_AHEAD_PX, TONE_ICON, originStays, returnsToFeed, type FeedOrigin, canLoadMore, changeSummary, clockText, datedLine, emptyFeed, feedArrived, feedFailed, feedPath, feedRefreshed, feedRequested, feedRow, feedSnack, feedTarget, feedView,
  groupFeedByDay, localDay, shouldAutoLoad,
  type FeedEntry,
} from './feed'

const entry = (id: string, over: Partial<FeedEntry> = {}): FeedEntry => ({
  id,
  kind: 'expense.created',
  at: '2026-11-02T15:42:10.000Z',
  actor: { id: 'me', name: 'Zach' },
  group: { id: 'g1', name: 'Tahoe', emoji: null, currency: 'USD' },
  target: { type: 'expense', id: 'e1', label: 'Dinner', live: true },
  expenseDate: null,
  amountMinor: 4000,
  previousAmountMinor: null,
  currency: 'USD',
  from: null,
  to: null,
  changes: null,
  direction: null,
  undo: false,
  ...over,
})

describe('feed paging state', () => {
  it('builds the request path with the page size, the group, and an encoded cursor', () => {
    expect(feedPath(null, null)).toBe(`/api/feed?limit=${PAGE_SIZE}`)
    expect(feedPath('g 1', null, 10)).toBe('/api/groups/g%201/feed?limit=10')
    expect(feedPath(null, '2026-11-02T10:00:00.123456Z|abc')).toBe(`/api/feed?limit=${PAGE_SIZE}&cursor=2026-11-02T10%3A00%3A00.123456Z%7Cabc`)
  })

  it('first page replaces, later pages append and skip repeats', () => {
    const first = feedArrived(feedRequested(emptyFeed, false), { items: [entry('a'), entry('b')], nextCursor: 'c1' }, false)
    expect(first).toMatchObject({ loaded: true, loading: false, nextCursor: 'c1', error: null })
    expect(first.items.map((i) => i.id)).toEqual(['a', 'b'])
    const more = feedArrived(feedRequested(first, true), { items: [entry('b'), entry('c')], nextCursor: null }, true)
    expect(more.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(more.nextCursor).toBeNull()
    // Reloading from the top (e.g. coming back to the tab) starts over.
    expect(feedArrived(more, { items: [entry('z')], nextCursor: null }, false).items.map((i) => i.id)).toEqual(['z'])
  })

  it('reloading keeps what is on screen until the new page lands', () => {
    const shown = feedArrived(emptyFeed, { items: [entry('a')], nextCursor: null }, false)
    const reloading = feedRequested(shown, false)
    expect(reloading.items).toHaveLength(1)
    expect(reloading.loading).toBe(true)
  })

  it('a failure keeps the list and the cursor so Try again can continue', () => {
    const shown = feedArrived(emptyFeed, { items: [entry('a')], nextCursor: 'c1' }, false)
    const failed = feedFailed(feedRequested(shown, true), 'Offline')
    expect(failed).toMatchObject({ error: 'Offline', loadingMore: false, nextCursor: 'c1' })
    expect(failed.items).toHaveLength(1)
    expect(canLoadMore(failed)).toBe(true)
  })

  it('only asks for more when there is a next page and nothing in flight', () => {
    const shown = feedArrived(emptyFeed, { items: [entry('a')], nextCursor: 'c1' }, false)
    expect(canLoadMore(shown)).toBe(true)
    expect(canLoadMore(feedRequested(shown, true))).toBe(false)
    expect(canLoadMore(feedArrived(shown, { items: [], nextCursor: null }, true))).toBe(false)
    expect(canLoadMore(emptyFeed)).toBe(false)
  })
})

describe('days and clock', () => {
  it('uses the viewer’s zone for the day and the time', () => {
    const at = '2026-11-02T03:30:00.000Z'
    expect(localDay(at, 0)).toBe('2026-11-02')
    expect(localDay(at, -480)).toBe('2026-11-01') // Los Angeles (PST) is still the evening before
    expect(clockText(at, -480)).toBe('7:30 PM')
    expect(clockText(at, 0)).toBe('3:30 AM')
    expect(clockText('2026-11-02T12:05:00.000Z', 0)).toBe('12:05 PM')
    expect(clockText('2026-11-02T00:05:00.000Z', 0)).toBe('12:05 AM')
    expect(localDay('nope')).toBe('')
    expect(clockText('nope')).toBe('')
  })

  it('cuts a newest-first list into days with headings', () => {
    const items = [
      entry('a', { at: '2026-11-02T20:00:00.000Z' }),
      entry('b', { at: '2026-11-02T09:00:00.000Z' }),
      entry('c', { at: '2026-11-01T22:00:00.000Z' }),
      entry('d', { at: '2026-10-28T12:00:00.000Z' }),
    ]
    const days = groupFeedByDay(items, '2026-11-02', 0)
    expect(days.map((d) => [d.heading, d.items.map((i) => i.id)])).toEqual([
      ['TODAY · NOV 2', ['a', 'b']], ['YESTERDAY · NOV 1', ['c']], ['WED · OCT 28', ['d']],
    ])
    expect(groupFeedByDay([], '2026-11-02')).toEqual([])
  })
})

describe('rows', () => {
  const row = (e: FeedEntry, show = false) => feedRow(e, 'me', { showGroup: show, offsetMinutes: -480 })

  it('who did what, the amount, and when', () => {
    const r = row(entry('a'))
    expect(r).toMatchObject({ title: 'You added “Dinner”', amount: '$40.00', details: [], previousAmount: null, meta: '7:42 AM', tone: 'add', struckLabel: false, struckAmount: false, icon: 'add' })
    expect(r.label).toBe('You added “Dinner”. $40.00. 7:42 AM')
  })

  it('the all-groups feed names the group', () => {
    expect(row(entry('a'), true).meta).toBe('7:42 AM · Tahoe')
    expect(row(entry('a', { group: { id: 'g1', name: 'Tahoe', emoji: '🏔️', currency: 'USD' } }), true).meta).toBe('7:42 AM · 🏔️ Tahoe')
  })

  it('an edit shows the new and old amount and what changed', () => {
    const r = row(entry('a', { kind: 'expense.updated', actor: { id: 'maya', name: 'Maya' }, amountMinor: 4000, previousAmountMinor: 3500, changes: [{ field: 'amount', from: 3500, to: 4000 }, { field: 'date', from: 'x', to: 'y' }] }))
    expect(r).toMatchObject({ title: 'Maya edited “Dinner”', amount: '$40.00', previousAmount: 'was $35.00', details: ['Changed the amount and date'], tone: 'edit' })
    expect(r.label).toBe('Maya edited “Dinner”. $40.00. was $35.00. Changed the amount and date. 7:42 AM')
  })

  it('a delete is struck through; an undo has the undo tone', () => {
    expect(row(entry('a', { kind: 'expense.deleted' }))).toMatchObject({ tone: 'delete', struckLabel: true, struckAmount: true })
    expect(row(entry('a', { kind: 'expense.restored', undo: true }))).toMatchObject({ tone: 'undo', struckLabel: false, struckAmount: false })
  })

  it('payments and undone payments', () => {
    const base = { target: { type: 'settlement' as const, id: 's1', label: '', live: true }, from: { id: 'maya', name: 'Maya' }, to: { id: 'me', name: 'Zach' }, amountMinor: 2500 }
    expect(row(entry('a', { ...base, kind: 'settlement.created', actor: { id: 'maya', name: 'Maya' } }))).toMatchObject({ title: 'Maya paid you', amount: '$25.00', tone: 'settle', struckAmount: false })
    expect(row(entry('a', { ...base, kind: 'settlement.created', target: { ...base.target, live: false } })).struckAmount).toBe(true)
    expect(row(entry('a', { ...base, kind: 'settlement.deleted', undo: true, target: { ...base.target, live: false } }))).toMatchObject({ title: 'You undid a payment', details: ['Maya paid you'], tone: 'undo' })
  })

  it('an amount that was never recorded just leaves the amount out', () => {
    const r = row(entry('a', { amountMinor: null }))
    expect(r.amount).toBeNull()
    expect(r.label).toBe('You added “Dinner”. 7:42 AM')
  })

  it('summarises changes, and says nothing when none were recorded', () => {
    expect(changeSummary(null)).toBeNull()
    expect(changeSummary([])).toBeNull()
    expect(changeSummary([{ field: 'description', from: 'a', to: 'b' }])).toBe('Changed the name')
    expect(changeSummary([{ field: 'payer', from: 1, to: 2 }, { field: 'split', from: 1, to: 2 }, { field: 'category', from: 1, to: 2 }])).toBe('Changed the who paid, split and category')
    expect(changeSummary([{ field: 'amount', from: 1, to: 2 }, { field: 'amount', from: 1, to: 2 }])).toBe('Changed the amount')
  })
})

describe('the expense’s own date', () => {
  const dated = (over: Partial<FeedEntry>) => entry('a', { expenseDate: '2026-10-24', ...over })
  it('shows "Dated Sat, Oct 24" when it differs from the day it was logged', () => {
    expect(datedLine(dated({}), '2026-11-02', -480)).toBe('Dated Sat, Oct 24')
    expect(row(dated({})).details).toEqual(['Dated Sat, Oct 24'])
    expect(row(dated({ kind: 'expense.updated', changes: [{ field: 'date', from: 'a', to: 'b' }] })).details).toEqual(['Changed the date', 'Dated Sat, Oct 24'])
  })
  it('says nothing when it was logged the same day (in the device zone), or for other kinds', () => {
    expect(datedLine(dated({ expenseDate: '2026-11-02' }), '2026-11-02', -480)).toBeNull()
    // 03:30 UTC on Nov 2 is still Nov 1 in Los Angeles: a Nov 1 expense is not backdated there.
    expect(datedLine(dated({ at: '2026-11-02T03:30:00.000Z', expenseDate: '2026-11-01' }), '2026-11-02', -480)).toBeNull()
    expect(datedLine(dated({ at: '2026-11-02T03:30:00.000Z', expenseDate: '2026-11-01' }), '2026-11-02', 0)).toBe('Dated Sun, Nov 1')
    expect(datedLine(dated({ kind: 'expense.deleted' }), '2026-11-02', -480)).toBeNull()
    expect(datedLine(entry('a'), '2026-11-02', -480)).toBeNull()
  })
  it('adds the year only when it is not this year', () => {
    expect(datedLine(dated({ expenseDate: '2025-12-12' }), '2026-11-02', -480)).toBe('Dated Fri, Dec 12, 2025')
  })
  const row = (e: FeedEntry) => feedRow(e, 'me', { showGroup: false, offsetMinutes: -480, today: '2026-11-02' })
})

describe('tones and icons', () => {
  it('every tone has a line icon, none an emoji', () => {
    expect(Object.keys(TONE_ICON).sort()).toEqual(['add', 'delete', 'edit', 'move', 'settle', 'undo'])
    for (const icon of Object.values(TONE_ICON)) expect(icon).toMatch(/^[a-z-]+$/)
  })
})

describe('keeping loaded pages', () => {
  const shown = (ids: string[], cursor: string | null) => feedArrived(emptyFeed, { items: ids.map((id) => entry(id)), nextCursor: cursor }, false)
  it('a quiet refresh puts new rows on top and keeps the older pages and their cursor', () => {
    const deep = feedArrived(shown(['d', 'e'], 'c1'), { items: [entry('f')], nextCursor: 'c2' }, true)
    const back = feedRefreshed(feedRequested(deep, false), { items: [entry('a'), entry('b'), entry('d')], nextCursor: 'c9' })
    expect(back.items.map((i) => i.id)).toEqual(['a', 'b', 'd', 'e', 'f'])
    expect(back.nextCursor).toBe('c2')
    expect(back).toMatchObject({ loading: false, loaded: true, error: null })
  })
  it('replaces the list when the new page does not reach back to it (no gap), or is the whole feed', () => {
    expect(feedRefreshed(shown(['d', 'e'], 'c1'), { items: [entry('a'), entry('b')], nextCursor: 'c9' }).items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(feedRefreshed(shown(['d', 'e'], 'c1'), { items: [entry('d')], nextCursor: null }).items.map((i) => i.id)).toEqual(['d'])
    expect(feedRefreshed(emptyFeed, { items: [entry('a')], nextCursor: null }).items.map((i) => i.id)).toEqual(['a'])
  })
  it('a refreshed row replaces its older copy', () => {
    const back = feedRefreshed(shown(['a', 'b'], 'c1'), { items: [{ ...entry('a'), amountMinor: 999 }], nextCursor: 'c9' })
    expect(back.items[0]!.amountMinor).toBe(999)
    expect(back.items.map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('states', () => {
  it('skeleton until the first page, then error, empty or list', () => {
    expect(feedView(emptyFeed)).toBe('loading')
    expect(feedView(feedRequested(emptyFeed, false))).toBe('loading')
    expect(feedView(feedFailed(feedRequested(emptyFeed, false), 'boom'))).toBe('error')
    expect(feedView(feedArrived(emptyFeed, { items: [], nextCursor: null }, false))).toBe('empty')
    const list = feedArrived(emptyFeed, { items: [entry('a')], nextCursor: null }, false)
    expect(feedView(list)).toBe('list')
    expect(feedView(feedRequested(list, false))).toBe('list') // a reload never brings the skeleton back over a list
    expect(feedView(feedFailed(list, 'boom'))).toBe('list') // a later failure keeps the list
  })
  it('a failure with a list on screen becomes a snackbar, never raw text', () => {
    const list = feedArrived(emptyFeed, { items: [entry('a')], nextCursor: 'c1' }, false)
    expect(feedSnack(list)).toBeNull()
    expect(feedSnack(feedFailed(feedRequested(list, true), 'Failed to fetch', true))).toEqual({ text: 'Couldn’t load older activity', action: 'Retry' })
    expect(feedSnack(feedFailed(feedRequested(list, false), 'Failed to fetch'))).toEqual({ text: 'Couldn’t refresh activity', action: 'Retry' })
    expect(feedSnack(feedFailed(emptyFeed, 'Failed to fetch'))).toBeNull() // no list: the full error view is shown instead
  })
  it('scrolling near the bottom loads the next page, but not while loading, at the end, or after an error', () => {
    const list = feedArrived(emptyFeed, { items: [entry('a')], nextCursor: 'c1' }, false)
    expect(shouldAutoLoad(list, LOAD_AHEAD_PX - 1)).toBe(true)
    expect(shouldAutoLoad(list, LOAD_AHEAD_PX + 1)).toBe(false)
    expect(shouldAutoLoad(feedRequested(list, true), 0)).toBe(false)
    expect(shouldAutoLoad(feedArrived(list, { items: [], nextCursor: null }, true), 0)).toBe(false)
    expect(shouldAutoLoad(feedFailed(feedRequested(list, true), 'x', true), 0)).toBe(false)
  })
  it('adds the year to a day heading only when it is not this year', () => {
    expect(groupFeedByDay([entry('a', { at: '2025-12-12T20:00:00.000Z' })], '2026-11-02', 0)[0]!.heading).toBe('FRI · DEC 12, 2025')
  })
})

describe('back to the feed', () => {
  const origin: FeedOrigin = { screen: 'activity', y: 1240, at: 'expense' }
  it('back from the screen a row opened returns to the feed it came from', () => {
    expect(returnsToFeed(origin, 'expense')).toBe(true)
    expect(returnsToFeed(origin, 'settle')).toBe(false)
    expect(returnsToFeed(null, 'expense')).toBe(false)
  })
  it('the origin is forgotten once the user is elsewhere', () => {
    expect(originStays(origin, 'expense')).toBe(true)
    expect(originStays(origin, 'group')).toBe(false)
    expect(originStays(origin, 'groups')).toBe(false)
  })
  it('a group opened from the feed keeps the origin through its own screens', () => {
    const g: FeedOrigin = { screen: 'groupActivity', y: 10, at: 'group' }
    for (const s of ['group', 'expense', 'settle', 'groupActivity']) expect(originStays(g, s)).toBe(true)
    expect(originStays(g, 'activity')).toBe(false)
    expect(returnsToFeed(g, 'group')).toBe(true)
    expect(returnsToFeed(g, 'expense')).toBe(false) // back from an expense in that group goes to the group first
  })
})

describe('tapping a row', () => {
  it('a live expense opens its detail', () => {
    expect(feedTarget(entry('a'))).toEqual({ kind: 'expense', groupId: 'g1', expenseId: 'e1' })
  })
  it('a deleted expense opens a read-only detail with Restore; one moved out of the group opens the group', () => {
    expect(feedTarget(entry('a', { kind: 'expense.deleted', target: { type: 'expense', id: 'e1', label: '', live: false } }))).toEqual({ kind: 'deleted', groupId: 'g1', expenseId: 'e1' })
    expect(feedTarget(entry('a', { kind: 'expense.created', target: { type: 'expense', id: 'e1', label: 'x', live: false } }))).toEqual({ kind: 'deleted', groupId: 'g1', expenseId: 'e1' })
    expect(feedTarget(entry('a', { kind: 'expense.moved', direction: 'out' }))).toEqual({ kind: 'group', groupId: 'g1' })
    expect(feedTarget(entry('a', { kind: 'expense.moved', direction: 'in' }))).toEqual({ kind: 'expense', groupId: 'g1', expenseId: 'e1' })
  })
  it('a payment opens the group’s payments', () => {
    expect(feedTarget(entry('a', { kind: 'settlement.created', target: { type: 'settlement', id: 's1', label: '', live: true } }))).toEqual({ kind: 'settle', groupId: 'g1' })
  })
  it('an expense row with no id falls back to the group', () => {
    expect(feedTarget(entry('a', { target: { type: 'expense', id: null, label: '', live: false } }))).toEqual({ kind: 'group', groupId: 'g1' })
  })
})
