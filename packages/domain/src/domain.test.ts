import { describe, expect, it } from 'vitest'
import {
  startingSplit,
  calendarDateInTimeZone,
  canMove,
  canRemove,
  categoryTotals,
  chartEntries,
  monthlyTotals,
  checkVersion,
  computeShares,
  convertMinor,
  directEdges,
  fillFromRate,
  formatMoney,
  LedgerError,
  nextMoneyFields,
  nextOccurrence,
  parseMajor,
  participantNets,
  paymentBetween,
  personalChartShares,
  retargetSettlement,
  sharesFromDefault,
  settleItemizedBill,
  sharesFromItems,
  simplifyNets,
  suggestedPayments,
} from './index.ts'

const anna = 'anna'
const bob = 'bob'
const charlie = 'charlie'

describe('splits', () => {
  it('gives the extra cent to the lowest id when remainders tie', () => {
    const shares = computeShares(1000, { type: 'equal', participantIds: [charlie, anna, bob] })
    expect(shares).toEqual([
      { participantId: charlie, minor: 333 },
      { participantId: anna, minor: 334 },
      { participantId: bob, minor: 333 },
    ])
    expect(shares.reduce((sum, row) => sum + row.minor, 0)).toBe(1000)
  })

  it('splits 70/30 exactly and rejects percents that do not add to 100', () => {
    expect(computeShares(1000, { type: 'percent', parts: [
      { participantId: anna, bps: 7000 },
      { participantId: bob, bps: 3000 },
    ] })).toEqual([
      { participantId: anna, minor: 700 },
      { participantId: bob, minor: 300 },
    ])
    expect(() => computeShares(1000, { type: 'percent', parts: [
      { participantId: anna, bps: 3333 },
      { participantId: bob, bps: 3333 },
      { participantId: charlie, bps: 3333 },
    ] })).toThrow(LedgerError)
  })

  it('lets a couple carry two shares and zero', () => {
    expect(computeShares(1000, { type: 'shares', parts: [
      { participantId: anna, weight: 2 },
      { participantId: bob, weight: 0 },
    ] })).toEqual([
      { participantId: anna, minor: 1000 },
      { participantId: bob, minor: 0 },
    ])
  })

  it('rejects exact shares that do not add up', () => {
    expect(() => computeShares(1000, { type: 'exact', amounts: [
      { participantId: anna, minor: 400 },
      { participantId: bob, minor: 400 },
    ] })).toThrow(/add up/)
  })

  it('splits yen with no fractional unit', () => {
    const shares = computeShares(1000, { type: 'equal', participantIds: [anna, bob, charlie] })
    expect(shares.map((row) => row.minor).sort((a, b) => a - b)).toEqual([333, 333, 334])
  })
})

describe('ledger', () => {
  const dinner = {
    id: 'e1',
    kind: 'expense' as const,
    payers: [{ participantId: bob, minor: 2000 }],
    shares: [
      { participantId: bob, minor: 0 },
      { participantId: anna, minor: 2000 },
    ],
  }
  const rent = {
    id: 'e2',
    kind: 'expense' as const,
    payers: [{ participantId: charlie, minor: 2000 }],
    shares: [
      { participantId: charlie, minor: 0 },
      { participantId: bob, minor: 2000 },
    ],
  }

  it('simplifies Anna owes Bob and Bob owes Charlie into one payment', () => {
    const nets = participantNets([dinner, rent], [])
    expect(nets.get(anna)).toBe(-2000)
    expect(nets.get(bob)).toBeUndefined()
    expect(nets.get(charlie)).toBe(2000)
    expect(simplifyNets(nets)).toEqual([{ fromId: anna, toId: charlie, minor: 2000 }])
    expect(suggestedPayments([dinner, rent], [], true)).toEqual([{ fromId: anna, toId: charlie, minor: 2000 }])
    expect(paymentBetween(directEdges([dinner, rent], []), anna, bob)?.minor).toBe(2000)
    expect(paymentBetween(suggestedPayments([dinner, rent], [], true), anna, bob)).toBeNull()
  })

  it('assigns a shortfall in proportion to who overpaid', () => {
    const edges = directEdges([{
      id: 'e',
      kind: 'expense',
      payers: [
        { participantId: bob, minor: 5000 },
        { participantId: charlie, minor: 4000 },
      ],
      shares: [
        { participantId: anna, minor: 3000 },
        { participantId: bob, minor: 3000 },
        { participantId: charlie, minor: 3000 },
      ],
    }], [])
    expect(edges).toEqual([
      { fromId: anna, toId: bob, minor: 2000 },
      { fromId: anna, toId: charlie, minor: 1000 },
    ])
  })

  it('breaks simplify ties by id', () => {
    const nets = new Map<string, number>([[anna, -4000], [charlie, 2000], [bob, 2000]])
    expect(simplifyNets(nets)).toEqual([
      { fromId: anna, toId: bob, minor: 2000 },
      { fromId: anna, toId: charlie, minor: 2000 },
    ])
  })

  it('reverses a refund with the reimbursement flag', () => {
    const flight = {
      id: 'flight',
      kind: 'expense' as const,
      payers: [{ participantId: anna, minor: 9000 }],
      shares: [anna, bob, charlie].map((id) => ({ participantId: id, minor: 3000 })),
    }
    const refund = { ...flight, id: 'refund', kind: 'reimbursement' as const }
    expect(participantNets([flight, refund], []).size).toBe(0)
  })

  it('clears every balance when the simplified payment is recorded', () => {
    const settlement = { id: 's', fromId: anna, toId: charlie, minor: 2000 }
    expect([...participantNets([dinner, rent], [settlement]).values()]).toEqual([])
    expect(suggestedPayments([dinner, rent], [settlement], true)).toEqual([])
  })

  it('lets an overpayment flip the direction', () => {
    const nets = participantNets([dinner, rent], [{
      id: 's',
      fromId: anna,
      toId: charlie,
      minor: 2500,
    }])
    expect(nets.get(anna)).toBe(500)
    expect(nets.get(charlie)).toBe(-500)
  })

  it('ignores deleted rows and blocks a nonzero removal', () => {
    const nets = participantNets([{ ...dinner, deleted: true }], [])
    expect(nets.size).toBe(0)
    expect(canRemove(0)).toBe(true)
    expect(canRemove(-20)).toBe(false)
  })

  it('moves only when every person on the expense is in the destination', () => {
    expect(canMove({
      actorInSource: true,
      actorInDestination: true,
      participantIds: [anna, bob],
      destinationMemberIds: [anna, bob],
    })).toBe(true)
    expect(canMove({
      actorInSource: true,
      actorInDestination: true,
      participantIds: [anna, charlie],
      destinationMemberIds: [anna, bob],
    })).toBe(false)
  })

  it('rejects a stale save', () => {
    expect(() => checkVersion(2, 1)).toThrow(/Reload/)
  })
})

describe('money fields', () => {
  const rateFor = (currency: string, date: string) => {
    if (currency === 'EUR' && date === '2026-09-01') return '1.08'
    if (currency === 'EUR' && date === '2026-09-02') return '1.10'
    return null
  }

  it('converts euros at the date rate and keeps an override', () => {
    expect(convertMinor(20000, 'EUR', '1.08', 'USD')).toBe(21600)
    const filled = fillFromRate({
      originalMinor: 20000,
      originalCurrency: 'EUR',
      groupCurrency: 'USD',
      rate: '1.08',
    })
    expect(filled.settlementMinor).toBe(21600)
    const agreed = nextMoneyFields({
      current: { ...filled, originalMinor: 20000, originalCurrency: 'EUR', date: '2026-09-01', overridden: false },
      patch: { settlementMinor: 22000 },
      groupCurrency: 'USD',
      rateFor,
    })
    expect(agreed.overridden).toBe(true)
    expect(agreed.settlementMinor).toBe(22000)
  })

  it('converts an agreed amount when the group currency changes, and refills when it does not', () => {
    const overridden = retargetSettlement({
      originalMinor: 20000,
      originalCurrency: 'EUR',
      settlementMinor: 22000,
      overridden: true,
      rate: '1.08',
      fromCurrency: 'USD',
      toCurrency: 'GBP',
      rateOriginalToTarget: '0.86',
      rateSettlementToTarget: '0.8',
    })
    expect(overridden.settlementMinor).toBe(17600)
    expect(overridden.overridden).toBe(true)

    const plain = retargetSettlement({
      originalMinor: 20000,
      originalCurrency: 'EUR',
      settlementMinor: 21600,
      overridden: false,
      rate: '1.08',
      fromCurrency: 'USD',
      toCurrency: 'GBP',
      rateOriginalToTarget: '0.86',
      rateSettlementToTarget: '0.8',
    })
    expect(plain.settlementMinor).toBe(17200)
    expect(plain.overridden).toBe(false)
  })

  it('keeps an override when only the date changes, and refills otherwise', () => {
    const current = {
      originalMinor: 20000,
      originalCurrency: 'EUR',
      settlementMinor: 22000,
      overridden: true,
      date: '2026-09-01',
      rate: '1.08',
    }
    const dated = nextMoneyFields({
      current,
      patch: { date: '2026-09-02' },
      groupCurrency: 'USD',
      rateFor,
    })
    expect(dated.settlementMinor).toBe(22000)
    expect(dated.overridden).toBe(true)

    const edited = nextMoneyFields({
      current,
      patch: { originalMinor: 10000 },
      groupCurrency: 'USD',
      rateFor,
    })
    expect(edited.settlementMinor).toBe(10800)
    expect(edited.overridden).toBe(false)
  })

  it('uses the original dollars for a personal chart unless the group agreed a different total', () => {
    const shares = [
      { participantId: anna, minor: 10800 },
      { participantId: bob, minor: 10800 },
    ]
    expect(personalChartShares({
      shares,
      originalMinor: 20000,
      originalCurrency: 'USD',
      settlementMinor: 21600,
      settlementCurrency: 'EUR',
      homeCurrency: 'USD',
      overridden: false,
      rateHomePerSettlement: '1.1',
    })).toEqual([
      { participantId: anna, minor: 10000 },
      { participantId: bob, minor: 10000 },
    ])
    const overridden = personalChartShares({
      shares: [{ participantId: anna, minor: 22000 }],
      originalMinor: 20000,
      originalCurrency: 'USD',
      settlementMinor: 22000,
      settlementCurrency: 'EUR',
      homeCurrency: 'USD',
      overridden: true,
      rateHomePerSettlement: '1',
    })
    expect(overridden[0]?.minor).toBe(22000)
  })
})

describe('itemization, defaults, dates', () => {
  it('converts an itemized receipt into the group currency and scales the shares', () => {
    const bill = settleItemizedBill({
      items: [
        { label: 'Steak', minor: 2000, participantIds: [anna] },
        { label: 'Salad', minor: 1000, participantIds: [bob] },
      ],
      taxMinor: 200,
      tipMinor: 0,
      discountMinor: 0,
      originalCurrency: 'EUR',
      groupCurrency: 'USD',
      rate: '1.08',
    })
    expect(bill.originalMinor).toBe(3200)
    expect(bill.settlementMinor).toBe(3456)
    expect(bill.overridden).toBe(false)
    expect(bill.shares).toEqual([
      { participantId: anna, minor: 2304 },
      { participantId: bob, minor: 1152 },
    ])
    expect(bill.shares.reduce((sum, share) => sum + share.minor, 0)).toBe(bill.settlementMinor)
  })

  it('spreads tax and tip in proportion to the items', () => {
    const result = sharesFromItems({
      items: [
        { label: 'Steak', minor: 4000, participantIds: [anna] },
        { label: 'Salad', minor: 1000, participantIds: [anna, bob] },
      ],
      taxMinor: 500,
      tipMinor: 500,
      discountMinor: 0,
    })
    expect(result.totalMinor).toBe(6000)
    expect(result.shares).toEqual([
      { participantId: anna, minor: 5400 },
      { participantId: bob, minor: 600 },
    ])
  })

  it('starts a new expense from a complete default and stays equal while a weight is missing', () => {
    expect(startingSplit([
      { id: anna, weight: 60 },
      { id: bob, weight: 40 },
      { id: charlie, weight: 0 },
    ])).toEqual({
      type: 'shares',
      parts: [
        { participantId: anna, weight: 60 },
        { participantId: bob, weight: 40 },
        { participantId: charlie, weight: 0 },
      ],
    })
    expect(startingSplit([
      { id: anna, weight: 60 },
      { id: bob, weight: null },
    ])).toEqual({ type: 'equal', participantIds: [anna, bob] })
    expect(sharesFromDefault(1000, [anna, bob], { [anna]: 60, [bob]: 40 })).toEqual([
      { participantId: anna, minor: 600 },
      { participantId: bob, minor: 400 },
    ])
  })

  it('renormalizes a default split for the people who were there', () => {
    const weights = { [anna]: 60, [bob]: 40, [charlie]: 0 }
    expect(sharesFromDefault(1000, [anna, bob], weights)).toEqual([
      { participantId: anna, minor: 600 },
      { participantId: bob, minor: 400 },
    ])
    expect(sharesFromDefault(1000, [anna, charlie], weights)).toEqual([
      { participantId: anna, minor: 1000 },
      { participantId: charlie, minor: 0 },
    ])
    expect(sharesFromDefault(1000, ['sam', 'lee'], {})).toEqual([
      { participantId: 'sam', minor: 500 },
      { participantId: 'lee', minor: 500 },
    ])
  })

  it('does not backfill a recurrence and clamps month ends', () => {
    expect(nextOccurrence('2026-01-01', 'monthly', '2026-09-26')).toBe('2026-10-01')
    expect(nextOccurrence('2026-09-01', 'monthly', '2026-09-01')).toBe('2026-10-01')
    expect(nextOccurrence('2026-10-01', 'monthly', '2026-09-26')).toBe('2026-10-01')
    expect(nextOccurrence('2026-01-01', 'monthly', '2026-09-26', '2026-09-30')).toBeNull()
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-01-31')).toBe('2026-02-28')
    expect(nextOccurrence('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-03-31')
  })

  it('rejects future dates and parses major units', () => {
    expect(parseMajor('10.50', 'USD')).toBe(1050)
    expect(parseMajor('1000', 'JPY')).toBe(1000)
    expect(() => parseMajor('10.5', 'JPY')).toThrow(LedgerError)
    expect(formatMoney(1050, 'USD')).toBe('$10.50')
    expect(formatMoney(-334, 'USD')).toBe('-$3.34')
    expect(calendarDateInTimeZone('UTC', new Date('2026-09-26T23:30:00Z'))).toBe('2026-09-26')
    expect(calendarDateInTimeZone('America/New_York', new Date('2026-09-27T02:00:00Z'))).toBe('2026-09-26')
    expect(calendarDateInTimeZone('Asia/Tokyo', new Date('2026-09-26T16:00:00Z'))).toBe('2026-09-27')
  })

  it('subtracts reimbursements from category charts', () => {
    const totals = categoryTotals([{
      id: '1',
      kind: 'expense',
      categoryId: 'cat_dining',
      date: '2026-09-02',
      originalMinor: 3000,
      originalCurrency: 'USD',
      settlementMinor: 3000,
      settlementCurrency: 'USD',
      overridden: false,
      payers: [{ participantId: anna, minor: 3000 }],
      shares: [
        { participantId: anna, minor: 1000 },
        { participantId: bob, minor: 2000 },
      ],
    }, {
      id: '2',
      kind: 'reimbursement',
      categoryId: 'cat_dining',
      date: '2026-09-03',
      originalMinor: 3000,
      originalCurrency: 'USD',
      settlementMinor: 3000,
      settlementCurrency: 'USD',
      overridden: false,
      payers: [{ participantId: anna, minor: 3000 }],
      shares: [
        { participantId: anna, minor: 1000 },
        { participantId: bob, minor: 2000 },
      ],
    }], bob, '2026-09-01', '2026-09-30')
    expect(totals).toEqual([{ categoryId: 'cat_dining', shareMinor: 0, paidMinor: 0 }])
  })

  it('buckets a share by month and drops anything outside the range', () => {
    const base = {
      kind: 'expense' as const,
      originalMinor: 2000,
      originalCurrency: 'USD',
      settlementMinor: 2000,
      settlementCurrency: 'USD',
      overridden: false,
      payers: [{ participantId: anna, minor: 2000 }],
      shares: [{ participantId: anna, minor: 1000 }],
    }
    const expenses = [
      { ...base, id: 'aug', categoryId: 'cat_rent', date: '2026-08-15' },
      { ...base, id: 'sep', categoryId: 'cat_dining', date: '2026-09-02', payers: [{ participantId: anna, minor: 900 }], shares: [{ participantId: anna, minor: 400 }] },
      { ...base, id: 'old', categoryId: 'cat_travel', date: '2026-07-01' },
      { ...base, id: 'gone', categoryId: 'cat_rent', date: '2026-08-20', deleted: true },
    ]
    expect(monthlyTotals(expenses, anna, '2026-08-01', '2026-09-30')).toEqual([
      { month: '2026-08', shareMinor: 1000, paidMinor: 2000 },
      { month: '2026-09', shareMinor: 400, paidMinor: 900 },
    ])
    expect(chartEntries(expenses, anna, '2026-08-01', '2026-09-30')).toEqual([
      { month: '2026-08', categoryId: 'cat_rent', shareMinor: 1000, paidMinor: 2000 },
      { month: '2026-09', categoryId: 'cat_dining', shareMinor: 400, paidMinor: 900 },
    ])
  })
})
