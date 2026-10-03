import { allocateByWeights } from './allocate.ts'
import { convertMinor } from './fx.ts'
import type { LedgerExpense } from './ledger.ts'

export type ChartExpense = LedgerExpense & {
  categoryId: string
  date: string
  originalMinor: number
  originalCurrency: string
  settlementMinor: number
  settlementCurrency: string
  overridden: boolean
}

export type ChartPoint = { shareMinor: number; paidMinor: number }

function chartPoint(expense: ChartExpense, participantId: string): ChartPoint {
  const share = expense.shares.find((row) => row.participantId === participantId)?.minor ?? 0
  const paid = expense.payers.find((row) => row.participantId === participantId)?.minor ?? 0
  const sign = expense.kind === 'reimbursement' ? -1 : 1
  return { shareMinor: sign * share, paidMinor: sign * paid }
}

function inChartRange(expense: ChartExpense, from: string, to: string) {
  return !expense.deleted && expense.date >= from && expense.date <= to
}

export function categoryTotals(
  expenses: ChartExpense[],
  participantId: string,
  from: string,
  to: string,
): { categoryId: string; shareMinor: number; paidMinor: number }[] {
  const totals = new Map<string, ChartPoint>()
  for (const expense of expenses) {
    if (!inChartRange(expense, from, to)) continue
    const point = chartPoint(expense, participantId)
    const bucket = totals.get(expense.categoryId) ?? { shareMinor: 0, paidMinor: 0 }
    bucket.shareMinor += point.shareMinor
    bucket.paidMinor += point.paidMinor
    totals.set(expense.categoryId, bucket)
  }
  return [...totals.entries()]
    .map(([categoryId, bucket]) => ({ categoryId, ...bucket }))
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId))
}

export function monthlyTotals(
  expenses: ChartExpense[],
  participantId: string,
  from: string,
  to: string,
): { month: string; shareMinor: number; paidMinor: number }[] {
  const totals = new Map<string, ChartPoint>()
  for (const expense of expenses) {
    if (!inChartRange(expense, from, to)) continue
    const month = expense.date.slice(0, 7)
    const point = chartPoint(expense, participantId)
    const bucket = totals.get(month) ?? { shareMinor: 0, paidMinor: 0 }
    bucket.shareMinor += point.shareMinor
    bucket.paidMinor += point.paidMinor
    totals.set(month, bucket)
  }
  return [...totals.entries()]
    .map(([month, bucket]) => ({ month, ...bucket }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

export function chartEntries(
  expenses: ChartExpense[],
  participantId: string,
  from: string,
  to: string,
): { month: string; categoryId: string; shareMinor: number; paidMinor: number }[] {
  const totals = new Map<string, { month: string; categoryId: string; shareMinor: number; paidMinor: number }>()
  for (const expense of expenses) {
    if (!inChartRange(expense, from, to)) continue
    const month = expense.date.slice(0, 7)
    const key = `${month}\0${expense.categoryId}`
    const point = chartPoint(expense, participantId)
    const bucket = totals.get(key) ?? { month, categoryId: expense.categoryId, shareMinor: 0, paidMinor: 0 }
    bucket.shareMinor += point.shareMinor
    bucket.paidMinor += point.paidMinor
    totals.set(key, bucket)
  }
  return [...totals.values()].sort((a, b) => a.month.localeCompare(b.month) || a.categoryId.localeCompare(b.categoryId))
}

export function personalChartShares(input: {
  shares: { participantId: string; minor: number }[]
  originalMinor: number
  originalCurrency: string
  settlementMinor: number
  settlementCurrency: string
  homeCurrency: string
  overridden: boolean
  rateHomePerSettlement: string | null
}): { participantId: string; minor: number }[] {
  const useOriginal =
    !input.overridden && input.originalCurrency.toUpperCase() === input.homeCurrency.toUpperCase()
  if (useOriginal) {
    return allocateByWeights(
      input.originalMinor,
      input.shares.map((share) => ({ id: share.participantId, weight: share.minor })),
    ).map((row) => ({ participantId: row.id, minor: row.minor }))
  }
  return input.shares.map((share) => ({
    participantId: share.participantId,
    minor: convertMinor(share.minor, input.settlementCurrency, input.rateHomePerSettlement ?? '1', input.homeCurrency),
  }))
}
