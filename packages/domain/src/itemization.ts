import { allocateByWeights, computeShares } from './allocate.ts'
import { fillFromRate } from './fx.ts'
import { LedgerError, assertMinor } from './money.ts'

export type DraftItem = {
  label: string
  minor: number
  participantIds: string[]
}

export function sharesFromItems(input: {
  items: DraftItem[]
  taxMinor: number
  tipMinor: number
  discountMinor: number
}): { totalMinor: number; shares: { participantId: string; minor: number }[] } {
  if (input.items.length === 0) throw new LedgerError('BAD_SPLIT', 'Add at least one item')
  for (const extra of [input.taxMinor, input.tipMinor, input.discountMinor]) {
    assertMinor(extra, 'Adjustment')
    if (extra < 0) throw new LedgerError('BAD_AMOUNT', 'Tax, tip, and discount cannot be negative')
  }
  const subtotals = new Map<string, number>()
  for (const item of input.items) {
    assertMinor(item.minor, 'Item')
    if (item.minor <= 0) throw new LedgerError('BAD_AMOUNT', 'Each item needs a positive amount')
    if (!item.label.trim()) throw new LedgerError('BAD_SPLIT', 'Each item needs a name')
    if (item.participantIds.length === 0) {
      throw new LedgerError('BAD_SPLIT', `Assign ${item.label} to someone`)
    }
    const parts = allocateByWeights(
      item.minor,
      item.participantIds.map((id) => ({ id, weight: 1 })),
    )
    for (const part of parts) {
      subtotals.set(part.id, (subtotals.get(part.id) ?? 0) + part.minor)
    }
  }
  const people = [...subtotals.entries()].map(([id, minor]) => ({ id, weight: minor }))
  const base = people.reduce((sum, person) => sum + person.weight, 0)
  const tax = allocateByWeights(input.taxMinor, people)
  const tip = allocateByWeights(input.tipMinor, people)
  const discount = allocateByWeights(input.discountMinor, people)
  const total = base + input.taxMinor + input.tipMinor - input.discountMinor
  if (total <= 0) throw new LedgerError('BAD_AMOUNT', 'The discount cannot wipe out the bill')
  const shares = people.map((person) => {
    const extra =
      (tax.find((row) => row.id === person.id)?.minor ?? 0) +
      (tip.find((row) => row.id === person.id)?.minor ?? 0) -
      (discount.find((row) => row.id === person.id)?.minor ?? 0)
    return { participantId: person.id, minor: person.weight + extra }
  })
  if (shares.some((row) => row.minor < 0)) {
    throw new LedgerError('BAD_SPLIT', 'A discount cannot make someone\'s share negative')
  }
  return { totalMinor: total, shares }
}

/** Item amounts are in the receipt currency. Shares are scaled into the group's settlement currency at the locked rate. */
export function settleItemizedBill(input: {
  items: DraftItem[]
  taxMinor: number
  tipMinor: number
  discountMinor: number
  originalCurrency: string
  groupCurrency: string
  rate: string | null
}): {
  originalMinor: number
  originalCurrency: string
  settlementMinor: number
  rate: string | null
  overridden: false
  shares: { participantId: string; minor: number }[]
} {
  const itemized = sharesFromItems(input)
  const originalCurrency = input.originalCurrency.toUpperCase()
  const groupCurrency = input.groupCurrency.toUpperCase()
  if (originalCurrency === groupCurrency) {
    return {
      originalMinor: itemized.totalMinor,
      originalCurrency,
      settlementMinor: itemized.totalMinor,
      rate: null,
      overridden: false,
      shares: itemized.shares,
    }
  }
  const filled = fillFromRate({
    originalMinor: itemized.totalMinor,
    originalCurrency,
    groupCurrency,
    rate: input.rate,
  })
  return {
    originalMinor: itemized.totalMinor,
    originalCurrency,
    settlementMinor: filled.settlementMinor,
    rate: filled.rate,
    overridden: false,
    shares: computeShares(filled.settlementMinor, {
      type: 'shares',
      parts: itemized.shares.map((share) => ({ participantId: share.participantId, weight: share.minor })),
    }),
  }
}
