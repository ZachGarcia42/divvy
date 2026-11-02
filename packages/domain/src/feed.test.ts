import { describe, expect, it } from 'vitest'
import {
  FEED_PAGE_DEFAULT,
  FEED_PAGE_MAX,
  buildFeedEntry,
  clampFeedLimit,
  decodeFeedCursor,
  encodeFeedCursor,
  feedAmountText,
  feedPaymentDetail,
  feedSegments,
  feedSentence,
  feedTone,
  isFeedKind,
  type FeedContext,
  type RawActivity,
} from './index.ts'

const group = { id: 'g1', name: 'Tahoe', emoji: null, currency: 'USD' }
const row = (over: Partial<RawActivity>): RawActivity => ({
  id: 'a1', kind: 'expense.created', summary: '', payload: {}, at: '2026-11-02T10:00:00.000Z', actor: { id: 'me', name: 'Zach' }, ...over,
})
const ctx = (over: Partial<FeedContext> = {}): FeedContext => ({ group, ...over })
const dinner = { id: 'e1', description: 'Dinner', settlementMinor: 4000, deleted: false }
const pay = { id: 's1', from: { id: 'maya', name: 'Maya' }, to: { id: 'me', name: 'Zach' }, minor: 2500, deleted: false }

describe('feed kinds', () => {
  it('lists expense and payment events, not group admin events', () => {
    expect(isFeedKind('expense.updated')).toBe(true)
    expect(isFeedKind('settlement.deleted')).toBe(true)
    expect(isFeedKind('member.joined')).toBe(false)
    expect(isFeedKind('group.archived')).toBe(false)
    expect(buildFeedEntry(row({ kind: 'member.joined' }), ctx())).toBeNull()
  })

  it('tones: add, edit, delete, undo, settle, move', () => {
    const tone = (kind: string) => feedTone({ kind } as never)
    expect([
      'expense.created', 'expense.updated', 'expense.deleted', 'expense.restored', 'settlement.created', 'settlement.deleted', 'settlement.restored', 'expense.moved', 'settlement.moved',
    ].map(tone)).toEqual(['add', 'edit', 'delete', 'undo', 'settle', 'undo', 'undo', 'move', 'move'])
  })
})

describe('buildFeedEntry: amounts', () => {
  it('a new expense takes its amount and name from the payload, even if the expense changed since', () => {
    const entry = buildFeedEntry(row({ payload: { expenseId: 'e1', settlementMinor: 3000, description: 'Lunch' } }), ctx({ expense: dinner }))!
    expect(entry.amountMinor).toBe(3000)
    expect(entry.target).toEqual({ type: 'expense', id: 'e1', label: 'Lunch', live: true })
    expect(entry.undo).toBe(false)
    expect(entry.currency).toBe('USD')
  })

  it('an older expense row without the amount falls back to the expense as it is now', () => {
    const entry = buildFeedEntry(row({ payload: { expenseId: 'e1', settlementMinor: undefined } }), ctx({ expense: dinner }))!
    expect(entry.amountMinor).toBe(4000)
    expect(entry.target.label).toBe('Dinner')
  })

  it('a deleted expense is not live and keeps the amount it had', () => {
    const entry = buildFeedEntry(row({ kind: 'expense.deleted', payload: { expenseId: 'e1', settlementMinor: 4000, description: 'Dinner' } }), ctx({ expense: { ...dinner, deleted: true } }))!
    expect(entry.target.live).toBe(false)
    expect(entry.amountMinor).toBe(4000)
  })

  it('a row whose expense is gone entirely still renders, with no amount', () => {
    const entry = buildFeedEntry(row({ payload: { expenseId: 'gone' } }), ctx())!
    expect(entry.amountMinor).toBeNull()
    expect(entry.target.live).toBe(false)
    expect(feedAmountText(entry)).toBeNull()
    expect(feedSentence(entry, 'me')).toBe('You added an expense')
  })

  it('edit with an amount change shows new and previous amounts', () => {
    const entry = buildFeedEntry(
      row({ kind: 'expense.updated', payload: { expenseId: 'e1', previous: { settlementMinor: 3500, description: 'Dinner' }, settlementMinor: 4000, description: 'Dinner' } }),
      ctx({ expense: dinner, changes: [{ field: 'amount', from: 3500, to: 4000 }] }),
    )!
    expect([entry.amountMinor, entry.previousAmountMinor]).toEqual([4000, 3500])
    expect(feedAmountText(entry)).toBe('$40.00 (was $35.00)')
  })

  it('older edit rows: the amount comes from the recorded change, then from the edit before it', () => {
    const legacyPayload = { expenseId: 'e1', previous: { settlementMinor: 3500, description: 'Dinner' } }
    // The expense was edited again later (now $90), but this edit's own change says $40.
    const changed = buildFeedEntry(row({ kind: 'expense.updated', payload: legacyPayload }), ctx({ expense: { ...dinner, settlementMinor: 9000 }, changes: [{ field: 'amount', from: 3500, to: 4000 }] }))!
    expect(changed.amountMinor).toBe(4000)
    // Edit changed only the date: amount is unchanged, so it is what the edit started from, not today's.
    const sameAmount = buildFeedEntry(row({ kind: 'expense.updated', payload: legacyPayload }), ctx({ expense: { ...dinner, settlementMinor: 9000 }, changes: [{ field: 'date', from: 'a', to: 'b' }] }))!
    expect(sameAmount.amountMinor).toBe(3500)
    expect(sameAmount.previousAmountMinor).toBeNull()
    // No recorded detail at all: best available is the expense now.
    const none = buildFeedEntry(row({ kind: 'expense.updated', payload: legacyPayload }), ctx({ expense: dinner, changes: null }))!
    expect(none.amountMinor).toBe(4000)
    expect(none.changes).toBeNull()
  })

  it('a rename edit shows the new name', () => {
    const entry = buildFeedEntry(
      row({ kind: 'expense.updated', payload: { expenseId: 'e1', previous: { settlementMinor: 4000, description: 'Dinner' } } }),
      ctx({ expense: { ...dinner, description: 'Later name' }, changes: [{ field: 'description', from: 'Dinner', to: 'Tacos' }] }),
    )!
    expect(entry.target.label).toBe('Tacos')
  })

  it('payments: amount and people from the payload, names from the payment', () => {
    const entry = buildFeedEntry(row({ kind: 'settlement.created', payload: { settlementId: 's1', minor: 2500, fromId: 'maya', toId: 'me' } }), ctx({ settlement: pay }))!
    expect(entry.amountMinor).toBe(2500)
    expect(entry.from).toEqual({ id: 'maya', name: 'Maya' })
    expect(entry.to).toEqual({ id: 'me', name: 'Zach' })
    expect(entry.target.type).toBe('settlement')
  })

  it('an older undone payment (no amount in the row) takes it from the payment itself and counts as an undo', () => {
    const entry = buildFeedEntry(row({ kind: 'settlement.deleted', payload: { settlementId: 's1' } }), ctx({ settlement: { ...pay, deleted: true } }))!
    expect(entry.amountMinor).toBe(2500)
    expect(entry.undo).toBe(true)
    expect(entry.target.live).toBe(false)
  })

  it('a restored expense is an undo; a restored payment is not flagged as one', () => {
    expect(buildFeedEntry(row({ kind: 'expense.restored', payload: { expenseId: 'e1' } }), ctx({ expense: dinner }))!.undo).toBe(true)
    expect(buildFeedEntry(row({ kind: 'settlement.restored', payload: { settlementId: 's1' } }), ctx({ settlement: pay }))!.undo).toBe(false)
  })

  it('moves: direction from the payload, else from the old summary text', () => {
    const fresh = buildFeedEntry(row({ kind: 'expense.moved', payload: { expenseId: 'e1', direction: 'in' } }), ctx({ expense: dinner }))!
    expect(fresh.direction).toBe('in')
    const old = buildFeedEntry(row({ kind: 'expense.moved', summary: 'Zach moved “Dinner” out', payload: { expenseId: 'e1' } }), ctx({ expense: dinner }))!
    expect(old.direction).toBe('out')
    const unknown = buildFeedEntry(row({ kind: 'settlement.moved', summary: '', payload: { settlementId: 's1' } }), ctx({ settlement: pay }))!
    expect(unknown.direction).toBeNull()
  })
})

describe('feedSentence', () => {
  const sentence = (r: Partial<RawActivity>, c: Partial<FeedContext> = {}, you: string | null = 'me') => feedSentence(buildFeedEntry(row(r), ctx(c))!, you)
  const live = { expense: dinner }

  it('says You for the viewer and the name for everyone else', () => {
    expect(sentence({ payload: { expenseId: 'e1' } }, live)).toBe('You added “Dinner”')
    expect(sentence({ payload: { expenseId: 'e1' }, actor: { id: 'maya', name: 'Maya' } }, live)).toBe('Maya added “Dinner”')
    expect(sentence({ payload: { expenseId: 'e1' }, actor: { id: null, name: null } }, live)).toBe('Someone added “Dinner”')
  })

  it('covers every expense verb', () => {
    expect(sentence({ kind: 'expense.updated', payload: { expenseId: 'e1' } }, live)).toBe('You edited “Dinner”')
    expect(sentence({ kind: 'expense.deleted', payload: { expenseId: 'e1' } }, live)).toBe('You deleted “Dinner”')
    expect(sentence({ kind: 'expense.restored', payload: { expenseId: 'e1' } }, live)).toBe('You restored “Dinner”')
    expect(sentence({ kind: 'expense.moved', payload: { expenseId: 'e1', direction: 'out' } }, live)).toBe('You moved “Dinner” to another group')
  })

  it('payments read as who paid whom, and say who recorded it when that was someone else', () => {
    const p = { settlement: pay }
    expect(sentence({ kind: 'settlement.created', payload: { settlementId: 's1' }, actor: { id: 'maya', name: 'Maya' } }, p)).toBe('Maya paid you')
    expect(sentence({ kind: 'settlement.created', payload: { settlementId: 's1' } }, p)).toBe('Maya paid you (recorded by You)')
    expect(sentence({ kind: 'settlement.created', payload: { settlementId: 's1' }, actor: { id: 'maya', name: 'Maya' } }, p, 'zed')).toBe('Maya paid Zach')
    expect(sentence({ kind: 'settlement.deleted', payload: { settlementId: 's1' } }, p)).toBe('You undid a payment')
    expect(sentence({ kind: 'settlement.restored', payload: { settlementId: 's1' } }, p)).toBe('You restored a payment')
    expect(sentence({ kind: 'settlement.moved', payload: { settlementId: 's1', direction: 'in' } }, p)).toBe('You moved a payment here from another group')
  })

  it('moves into this group say so', () => {
    expect(sentence({ kind: 'expense.moved', payload: { expenseId: 'e1', direction: 'in' } }, live, 'me')).toBe('You moved “Dinner” here from another group')
  })

  it('cuts the sentence into heavy names and labels and a regular verb', () => {
    const entry = buildFeedEntry(row({ kind: 'expense.updated', payload: { expenseId: 'e1' }, actor: { id: 'maya', name: 'Maya' } }), ctx(live))!
    expect(feedSegments(entry, 'me')).toEqual([
      { text: 'Maya', style: 'strong' }, { text: ' edited ', style: 'plain' }, { text: '“Dinner”', style: 'label' },
    ])
    const paid = buildFeedEntry(row({ kind: 'settlement.created', payload: { settlementId: 's1' }, actor: { id: 'maya', name: 'Maya' } }), ctx({ settlement: pay }))!
    expect(feedSegments(paid, 'me').map((s) => s.style)).toEqual(['strong', 'plain', 'strong'])
  })

  it('shortens a very long label in the middle', () => {
    const long = 'A'.repeat(30) + 'B'.repeat(30)
    const entry = buildFeedEntry(row({ payload: { expenseId: 'e1', description: long } }), ctx(live))!
    const label = feedSegments(entry, 'me', 40).find((s) => s.style === 'label')!.text
    expect(label.length).toBeLessThanOrEqual(42)
    expect(label).toContain('…')
    expect(feedSentence(entry, 'me')).toContain(long) // the plain sentence keeps the full label
  })

  it('an undone or restored payment names who paid whom on its own line', () => {
    const undone = buildFeedEntry(row({ kind: 'settlement.deleted', payload: { settlementId: 's1' } }), ctx({ settlement: pay }))!
    expect(feedPaymentDetail(undone, 'me')).toBe('Maya paid you')
    expect(feedPaymentDetail(buildFeedEntry(row({ kind: 'settlement.restored', payload: { settlementId: 's1' } }), ctx({ settlement: pay }))!, 'zed')).toBe('Maya paid Zach')
    expect(feedPaymentDetail(buildFeedEntry(row({ kind: 'settlement.created', payload: { settlementId: 's1' } }), ctx({ settlement: pay }))!, 'me')).toBeNull()
    expect(feedPaymentDetail(buildFeedEntry(row({ kind: 'settlement.deleted', payload: { settlementId: 'gone' } }), ctx())!, 'me')).toBeNull()
  })

  it('carries the expense’s own date', () => {
    expect(buildFeedEntry(row({ payload: { expenseId: 'e1' } }), ctx({ expense: { ...dinner, date: '2026-10-24' } }))!.expenseDate).toBe('2026-10-24')
    expect(buildFeedEntry(row({ payload: { expenseId: 'e1' } }), ctx({ expense: dinner }))!.expenseDate).toBeNull()
    expect(buildFeedEntry(row({ kind: 'settlement.created', payload: { settlementId: 's1' } }), ctx({ settlement: pay }))!.expenseDate).toBeNull()
  })

  it('a payment that no longer exists still reads sensibly', () => {
    expect(sentence({ kind: 'settlement.created', payload: { settlementId: 'gone' } })).toBe('You recorded a payment')
    expect(sentence({ kind: 'settlement.deleted', payload: { settlementId: 'gone' } })).toBe('You undid a payment')
  })

  it('a blank description reads as “an expense”', () => {
    expect(sentence({ payload: { expenseId: 'e1' } }, { expense: { ...dinner, description: '  ' } })).toBe('You added an expense')
  })
})

describe('paging helpers', () => {
  it('clamps the page size', () => {
    expect(clampFeedLimit(undefined)).toBe(FEED_PAGE_DEFAULT)
    expect(clampFeedLimit('')).toBe(FEED_PAGE_DEFAULT)
    expect(clampFeedLimit('abc')).toBe(FEED_PAGE_DEFAULT)
    expect(clampFeedLimit('10')).toBe(10)
    expect(clampFeedLimit(7.9)).toBe(7)
    expect(clampFeedLimit('0')).toBe(1)
    expect(clampFeedLimit('-5')).toBe(1)
    expect(clampFeedLimit('100000')).toBe(FEED_PAGE_MAX)
  })

  it('cursors round-trip, and anything else is refused with BAD_CURSOR', () => {
    const cursor = { at: '2026-11-02T10:00:00.123456Z', id: 'abc-123' }
    expect(decodeFeedCursor(encodeFeedCursor(cursor))).toEqual(cursor)
    expect(decodeFeedCursor(undefined)).toBeNull()
    expect(decodeFeedCursor(null)).toBeNull()
    expect(decodeFeedCursor('')).toBeNull()
    for (const bad of ['nope', '2026-11-02T10:00:00Z|x', '2026-11-02T10:00:00.123456Z|', '2026-11-02T10:00:00.123456Z|a b', "2026-11-02T10:00:00.123456Z|x';drop", '2026-13-45T99:00:00.123456Z|x']) {
      expect(() => decodeFeedCursor(bad), bad).toThrowError(expect.objectContaining({ code: 'BAD_CURSOR' }))
    }
  })
})
