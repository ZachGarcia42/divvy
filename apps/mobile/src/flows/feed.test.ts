import { describe, expect, it } from 'vitest'
import {
  PAGE_SIZE, LOAD_AHEAD_PX, TONE_ICON, originStays, returnsToFeed, type FeedOrigin, canLoadMore, changeSummary, clockText, datedLine, emptyFeed, feedArrived, feedFailed, feedPath, feedRefreshed, feedRequested, feedRow, feedSnack, feedTarget, feedView,
  groupFeedByDay, localDay, shouldAutoLoad,
  SECTION_ROWS, activeChip, buildSections, dayLabel, emptySections, feedChips, sectionsArrived, sectionsAsFeed, sectionsFailed, sectionsMissing, sectionsPath, sectionsRequested, sectionsUnavailable,
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
  originalMinor: null,
  originalCurrency: null,
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
    expect(Object.keys(TONE_ICON).sort()).toEqual(['add', 'delete', 'edit', 'move', 'photo', 'settle', 'undo'])
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

describe('feed rows: converted amounts and receipt photos', () => {
  it('shows the original amount under a converted expense and says so for screen readers', () => {
    const row = feedRow(entry('c1', { originalMinor: 1000, originalCurrency: 'EUR', amountMinor: 1100 }), 'me', { showGroup: false })
    expect(row.amount).toBe('$11.00')
    expect(row.originalAmount).toBe('€10.00')
    expect(row.label).toContain('entered as €10.00')
    expect(feedRow(entry('c2'), 'me', { showGroup: false }).originalAmount).toBeNull()
  })

  it('a receipt photo row has a camera icon and reads as a sentence', () => {
    const row = feedRow(entry('p1', { kind: 'expense.photo_added' }), 'me', { showGroup: false })
    expect(row.icon).toBe('camera-outline')
    expect(row.title).toBe('You added a receipt to “Dinner”')
  })
})

// ─── Split by group ───

const inGroup = (id: string, gid: string, name: string, at: string, emoji: string | null = null) =>
  entry(id, { at, group: { id: gid, name, emoji, currency: 'USD' } })

describe('split by group: sections', () => {
  const tahoe: FeedEntry['group'] = { id: 'tahoe', name: 'Tahoe', emoji: null, currency: 'USD' }
  const mission: FeedEntry['group'] = { id: 'mission', name: 'Mission St', emoji: '🏠', currency: 'USD' }
  const mk = (gid: string, group: FeedEntry['group'], n: number, from = 0) => Array.from({ length: n }, (_, i) => inGroup(`${gid}${from + i}`, gid, group.name, `2026-11-02T${String(20 - from - i).padStart(2, '0')}:00:00.000Z`))
  const data = [
    { group: tahoe, total: 130, items: mk('tahoe', tahoe, SECTION_ROWS) },
    { group: mission, total: 1, items: mk('mission', mission, 1) },
  ]
  const page = (items: ReturnType<typeof mk>, nextCursor: string | null, extra = {}) => ({ ...emptyFeed, loaded: true, items, nextCursor, ...extra })

  it('one section per group the server sent, in its order, with the server’s counts: a busy group does not crowd the others out', () => {
    const sections = buildSections(data)
    expect(sections.map((s) => s.group.id)).toEqual(['tahoe', 'mission'])
    expect(sections.map((s) => s.total)).toEqual([130, 1])
    // Only the newest four on screen, and "Show N more" counts what is really left, not what happens to be loaded.
    expect(sections[0]).toMatchObject({ hidden: 126, expanded: false, loadingMore: false, failed: false })
    expect(sections[0]!.shown.map((i) => i.id)).toEqual(['tahoe0', 'tahoe1', 'tahoe2', 'tahoe3'])
    expect(sections[1]).toMatchObject({ hidden: 0 })
  })
  it('no groups with activity: no sections', () => expect(buildSections([])).toEqual([]))
  it('exactly the rows the server sent is not folded; one more is', () => {
    expect(buildSections([{ group: tahoe, total: SECTION_ROWS, items: mk('t', tahoe, SECTION_ROWS) }])[0]!.hidden).toBe(0)
    expect(buildSections([{ group: tahoe, total: SECTION_ROWS + 1, items: mk('t', tahoe, SECTION_ROWS) }])[0]!.hidden).toBe(1)
  })
  it('opening a section shows what its own feed has loaded, and the count falls as pages arrive', () => {
    const open = { tahoe: true }
    // Opened, nothing back yet: the same four, the same count, and it says it is loading.
    expect(buildSections(data, { tahoe: { ...emptyFeed, loading: true } }, open)[0]).toMatchObject({ expanded: true, hidden: 126, loadingMore: true })
    const loaded = mk('tahoe', tahoe, 30)
    const first = buildSections(data, { tahoe: page(loaded, 'c1') }, open)[0]!
    expect(first.shown).toHaveLength(30)
    expect(first.hidden).toBe(100)
    expect(buildSections(data, { tahoe: page(loaded, 'c1', { loadingMore: true }) }, open)[0]!.loadingMore).toBe(true)
    // A quiet refresh of what is loaded is not "loading more".
    expect(buildSections(data, { tahoe: page(loaded, 'c1', { loading: true }) }, open)[0]!.loadingMore).toBe(false)
    expect(buildSections(data, { tahoe: page(loaded, 'c1', { error: 'x', errorMore: true }) }, open)[0]!.failed).toBe(true)
  })
  it('a section that has been read to the end has nothing hidden, even when the count was a moment out of date', () => {
    const all = mk('tahoe', tahoe, 6)
    const [section] = buildSections([{ group: tahoe, total: 7, items: all.slice(0, SECTION_ROWS) }], { tahoe: page(all, null) }, { tahoe: true })
    expect(section!.shown).toHaveLength(6)
    expect(section!.hidden).toBe(0)
  })
  it('closing a section goes back to the newest four whatever was loaded', () => {
    const [closed] = buildSections(data, { tahoe: page(mk('tahoe', tahoe, 30), 'c1') }, { tahoe: false })
    expect(closed!.shown).toHaveLength(SECTION_ROWS)
    expect(closed!.hidden).toBe(126)
  })
  it('the sections request and its states', () => {
    expect(sectionsPath()).toBe('/api/feed/sections?per=4')
    const loading = sectionsRequested(emptySections)
    expect(sectionsAsFeed(loading)).toMatchObject({ loading: true, loaded: false, items: [] })
    const arrived = sectionsArrived({ sections: data })
    expect(arrived).toMatchObject({ loaded: true, loading: false, error: null })
    // A refresh keeps what is on screen; a failure keeps it too and says so.
    expect(sectionsRequested(arrived).sections).toHaveLength(2)
    const failed = sectionsFailed(arrived, 'offline')
    expect(failed.sections).toHaveLength(2)
    expect(sectionsAsFeed(failed)).toMatchObject({ error: 'offline', loaded: true, nextCursor: null })
    expect(sectionsAsFeed(failed).items).toHaveLength(5)
    expect(sectionsAsFeed(sectionsArrived({ sections: [] }))).toMatchObject({ loaded: true, items: [] })
  })
  it('a reply without a sections array does not blank Activity: it falls back to the plain feed (B-5)', () => {
    for (const reply of [{}, { sections: null }, { sections: 'x' }, null, undefined]) {
      const state = sectionsArrived(reply as never)
      expect(state).toMatchObject({ flat: true, loaded: true, error: null, sections: [] })
      expect(() => sectionsAsFeed(state)).not.toThrow()
    }
    expect(sectionsArrived({ sections: data }).flat).toBeUndefined()
  })
  it('an empty or junk-only sections reply falls back to the plain feed too', () => {
    const junk = [[], [null, 1, 'x'], [{ group: data[0]!.group, total: 3 }], [{ group: data[0]!.group, total: 2, items: [] }], [{ group: data[0]!.group, total: 2, items: [null, {}, { id: 5 }, 'x'] }], [{ total: 1, items: data[1]!.items }]]
    for (const sections of junk) expect(sectionsArrived({ sections } as never)).toMatchObject({ flat: true, loaded: true, error: null, sections: [] })
  })
  it('a missing route (404, 405, 501) means the plain feed; other failures stay errors', () => {
    for (const status of [404, 405, 501]) expect(sectionsUnavailable({ status })).toBe(true)
    for (const status of [400, 401, 429, 500, 502, 503, undefined]) expect(sectionsUnavailable({ status })).toBe(false)
    expect(sectionsUnavailable(null)).toBe(false)
    expect(sectionsMissing()).toMatchObject({ flat: true, loaded: true, error: null })
  })
  it('a section without a group or without drawable entries is dropped, junk entries inside a good section too', () => {
    const state = sectionsArrived({ sections: [{ group: data[0]!.group, total: 3 }, { total: 1, items: [] }, null, { group: data[1]!.group, total: 5, items: [null, data[1]!.items[0]] }, data[0]] })
    expect(state.flat).toBeUndefined()
    expect(state.sections.map((section) => section.group.id)).toEqual(['mission', 'tahoe'])
    expect(state.sections[0]).toMatchObject({ total: 5 })
    expect(state.sections[0]!.items).toHaveLength(1)
    expect(() => buildSections(state.sections)).not.toThrow()
  })
})

describe('split by group: chips', () => {
  const groups = [
    { id: 'nopa', name: '🍜 Nopa', archived: false },
    { id: 'mission', name: 'Mission St', emoji: '🏠', archived: false },
    { id: 'tahoe', name: 'Tahoe', archived: false },
    { id: 'old', name: 'Old trip', archived: true },
    { id: 'quiet', name: 'Quiet', archived: false },
  ]
  const items = [{ id: 'tahoe', name: 'Tahoe', emoji: null, currency: 'USD' }, { id: 'mission', name: 'Mission St', emoji: '🏠', currency: 'USD' }]
  it('All first, then groups with the latest activity, then the rest in list order; archived groups with nothing on screen are left out', () => {
    const chips = feedChips(groups, items)
    expect(chips.map((c) => c.id)).toEqual([null, 'tahoe', 'mission', 'nopa', 'quiet'])
    expect(chips[0]).toMatchObject({ title: 'All', emoji: '' })
    expect(chips.find((c) => c.id === 'mission')).toMatchObject({ emoji: '🏠', title: 'Mission St' })
    expect(chips.find((c) => c.id === 'nopa')).toMatchObject({ emoji: '🍜', title: 'Nopa' })
  })
  it('an archived group that still has activity on screen keeps its chip', () => {
    const chips = feedChips(groups, [{ id: 'old', name: 'Old trip', emoji: null, currency: 'USD' }])
    expect(chips.map((c) => c.id)).toContain('old')
  })
  it('a group in the feed that the list does not have yet still gets a chip', () => {
    expect(feedChips([], items).map((c) => c.id)).toEqual([null, 'tahoe', 'mission'])
  })
  it('no groups: just All', () => expect(feedChips([], []).map((c) => c.id)).toEqual([null]))
  it('the picked chip falls back to All when that group is gone', () => {
    const chips = feedChips(groups, items)
    expect(activeChip(chips, 'tahoe')).toBe('tahoe')
    expect(activeChip(chips, 'gone')).toBeNull()
    expect(activeChip(chips, null)).toBeNull()
  })
})

describe('split by group: rows, paths and paging', () => {
  const e = entry('x', { at: '2026-11-01T18:05:00.000Z' })
  it('a row with no day heading above it says the day', () => {
    expect(feedRow(e, 'me', { showGroup: false, showDay: true, today: '2026-11-02', offsetMinutes: 0 }).meta).toBe('Yesterday · 6:05 PM')
    expect(feedRow(entry('y', { at: '2026-11-02T09:12:00.000Z' }), 'me', { showGroup: false, showDay: true, today: '2026-11-02', offsetMinutes: 0 }).meta).toBe('Today · 9:12 AM')
    expect(feedRow(e, 'me', { showGroup: false, today: '2026-11-02', offsetMinutes: 0 }).meta).toBe('6:05 PM')
    expect(feedRow(e, 'me', { showGroup: true, showDay: true, today: '2026-11-02', offsetMinutes: 0 }).meta).toBe('Yesterday · 6:05 PM · Tahoe')
  })
  it('names the day: Today, Yesterday, then weekday and date (with the year when it is not this year)', () => {
    expect(dayLabel('2026-11-02T10:00:00.000Z', '2026-11-02', 0)).toBe('Today')
    expect(dayLabel('2026-10-30T10:00:00.000Z', '2026-11-02', 0)).toBe('Fri, Oct 30')
    expect(dayLabel('2025-12-12T10:00:00.000Z', '2026-11-02', 0)).toBe('Fri, Dec 12, 2025')
    expect(dayLabel('nonsense', '2026-11-02', 0)).toBe('')
  })
  it('a group chip asks for that group’s own feed, All for the whole one', () => {
    expect(feedPath('tahoe', null)).toBe('/api/groups/tahoe/feed?limit=30')
    expect(feedPath(null, 'c')).toBe('/api/feed?limit=30&cursor=c')
  })
})
