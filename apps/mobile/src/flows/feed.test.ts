import { describe, expect, it } from 'vitest'
import {
  PAGE_SIZE, canLoadMore, changeSummary, clockText, emptyFeed, feedArrived, feedFailed, feedPath, feedRequested, feedRow, feedTarget, groupFeedByDay, localDay,
  type FeedEntry,
} from './feed'

const entry = (id: string, over: Partial<FeedEntry> = {}): FeedEntry => ({
  id,
  kind: 'expense.created',
  at: '2026-11-02T15:42:10.000Z',
  actor: { id: 'me', name: 'Zach' },
  group: { id: 'g1', name: 'Tahoe', emoji: null, currency: 'USD' },
  target: { type: 'expense', id: 'e1', label: 'Dinner', live: true },
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
    expect(r).toMatchObject({ title: 'You added “Dinner”', amount: '$40.00', detail: null, meta: '7:42 AM', tone: 'add', struck: false })
    expect(r.label).toBe('You added “Dinner”. $40.00. 7:42 AM')
  })

  it('the all-groups feed names the group', () => {
    expect(row(entry('a'), true).meta).toBe('7:42 AM · Tahoe')
  })

  it('an edit shows the new and old amount and what changed', () => {
    const r = row(entry('a', { kind: 'expense.updated', actor: { id: 'maya', name: 'Maya' }, amountMinor: 4000, previousAmountMinor: 3500, changes: [{ field: 'amount', from: 3500, to: 4000 }, { field: 'date', from: 'x', to: 'y' }] }))
    expect(r).toMatchObject({ title: 'Maya edited “Dinner”', amount: '$40.00 (was $35.00)', detail: 'Changed the amount and date', tone: 'edit' })
  })

  it('a delete is struck through; an undo has the undo tone', () => {
    expect(row(entry('a', { kind: 'expense.deleted' }))).toMatchObject({ tone: 'delete', struck: true })
    expect(row(entry('a', { kind: 'expense.restored', undo: true }))).toMatchObject({ tone: 'undo', struck: false })
  })

  it('payments and undone payments', () => {
    const base = { target: { type: 'settlement' as const, id: 's1', label: '', live: true }, from: { id: 'maya', name: 'Maya' }, to: { id: 'me', name: 'Zach' }, amountMinor: 2500 }
    expect(row(entry('a', { ...base, kind: 'settlement.created', actor: { id: 'maya', name: 'Maya' } }))).toMatchObject({ title: 'Maya paid you', amount: '$25.00', tone: 'settle', struck: false })
    expect(row(entry('a', { ...base, kind: 'settlement.created', target: { ...base.target, live: false } })).struck).toBe(true)
    expect(row(entry('a', { ...base, kind: 'settlement.deleted', undo: true, target: { ...base.target, live: false } }))).toMatchObject({ title: 'You undid a payment (Maya paid you)', tone: 'undo' })
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

describe('tapping a row', () => {
  it('a live expense opens its detail', () => {
    expect(feedTarget(entry('a'))).toEqual({ kind: 'expense', groupId: 'g1', expenseId: 'e1' })
  })
  it('a deleted expense, or one moved out of the group, opens the group instead', () => {
    expect(feedTarget(entry('a', { kind: 'expense.deleted', target: { type: 'expense', id: 'e1', label: '', live: false } }))).toEqual({ kind: 'group', groupId: 'g1' })
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
