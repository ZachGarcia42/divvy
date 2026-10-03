import { LedgerError, assertMinor } from './money.ts'

export type Weighted = { id: string; weight: number }

/** Split `total` minor units by weight. Leftover units go to the largest fractional remainders, ties by id. */
export function allocateByWeights(total: number, weights: Weighted[]): { id: string; minor: number }[] {
  assertMinor(total, 'Total')
  if (total < 0) {
    throw new LedgerError('BAD_AMOUNT', 'Total cannot be negative')
  }
  const rows = weights.map((entry) => {
    if (!entry.id) throw new LedgerError('BAD_SPLIT', 'Missing participant')
    if (!Number.isInteger(entry.weight) || entry.weight < 0) {
      throw new LedgerError('BAD_SPLIT', 'Weights must be zero or a positive integer')
    }
    return { id: entry.id, weight: entry.weight }
  })
  const ids = new Set<string>()
  for (const row of rows) {
    if (ids.has(row.id)) throw new LedgerError('BAD_SPLIT', 'A person is listed twice')
    ids.add(row.id)
  }
  const sum = rows.reduce((acc, row) => acc + row.weight, 0)
  if (sum === 0) {
    if (total === 0) return rows.map((row) => ({ id: row.id, minor: 0 }))
    throw new LedgerError('BAD_SPLIT', 'At least one weight must be positive')
  }
  const staged = rows.map((row) => {
    const product = total * row.weight
    return { id: row.id, minor: Math.floor(product / sum), remainder: product % sum }
  })
  let left = total - staged.reduce((acc, row) => acc + row.minor, 0)
  const order = [...staged].sort((a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : 1))
  for (const row of order) {
    if (left === 0) break
    row.minor += 1
    left -= 1
  }
  return staged.map((row) => ({ id: row.id, minor: row.minor }))
}

export type SplitSpec =
  | { type: 'equal'; participantIds: string[] }
  | { type: 'exact'; amounts: { participantId: string; minor: number }[] }
  | { type: 'percent'; parts: { participantId: string; bps: number }[] }
  | { type: 'shares'; parts: { participantId: string; weight: number }[] }

export function computeShares(totalMinor: number, spec: SplitSpec): { participantId: string; minor: number }[] {
  assertMinor(totalMinor, 'Total')
  if (spec.type === 'equal') {
    if (spec.participantIds.length === 0) {
      throw new LedgerError('BAD_SPLIT', 'Choose at least one person')
    }
    return allocateByWeights(
      totalMinor,
      spec.participantIds.map((id) => ({ id, weight: 1 })),
    ).map((row) => ({ participantId: row.id, minor: row.minor }))
  }
  if (spec.type === 'exact') {
    const amounts = spec.amounts.map((row) => {
      assertMinor(row.minor, 'Share')
      if (row.minor < 0) throw new LedgerError('BAD_SPLIT', 'Shares cannot be negative')
      return row
    })
    const sum = amounts.reduce((acc, row) => acc + row.minor, 0)
    if (sum !== totalMinor) {
      throw new LedgerError('UNBALANCED', 'Exact shares must add up to the total')
    }
    assertUnique(amounts.map((row) => row.participantId))
    return amounts
  }
  if (spec.type === 'percent') {
    const sum = spec.parts.reduce((acc, row) => acc + row.bps, 0)
    if (spec.parts.some((row) => !Number.isInteger(row.bps) || row.bps < 0)) {
      throw new LedgerError('BAD_SPLIT', 'Percents must be zero or positive')
    }
    if (sum !== 10_000) {
      throw new LedgerError('PERCENT_SUM', 'Percents must add up to 100')
    }
    assertUnique(spec.parts.map((row) => row.participantId))
    return allocateByWeights(
      totalMinor,
      spec.parts.map((row) => ({ id: row.participantId, weight: row.bps })),
    ).map((row) => ({ participantId: row.id, minor: row.minor }))
  }
  if (spec.parts.some((row) => !Number.isInteger(row.weight) || row.weight < 0)) {
    throw new LedgerError('BAD_SPLIT', 'Shares must be zero or a positive integer')
  }
  assertUnique(spec.parts.map((row) => row.participantId))
  return allocateByWeights(
    totalMinor,
    spec.parts.map((row) => ({ id: row.participantId, weight: row.weight })),
  ).map((row) => ({ participantId: row.id, minor: row.minor }))
}

export function assertPayers(
  totalMinor: number,
  payers: { participantId: string; minor: number }[],
): void {
  if (payers.length === 0) throw new LedgerError('BAD_SPLIT', 'Choose who paid')
  assertUnique(payers.map((row) => row.participantId))
  let sum = 0
  for (const payer of payers) {
    assertMinor(payer.minor, 'Payment')
    if (payer.minor < 0) throw new LedgerError('BAD_SPLIT', 'Payments cannot be negative')
    sum += payer.minor
  }
  if (sum !== totalMinor) {
    throw new LedgerError('UNBALANCED', 'Payments must add up to the total')
  }
}

function assertUnique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new LedgerError('BAD_SPLIT', 'A person is listed twice')
  }
}

export function involvedIds(
  payers: { participantId: string }[],
  shares: { participantId: string }[],
): string[] {
  return [...new Set([...payers.map((row) => row.participantId), ...shares.map((row) => row.participantId)])]
}

export function assertInvolved(payers: { participantId: string }[], shares: { participantId: string }[]): string[] {
  const ids = involvedIds(payers, shares)
  if (ids.length < 2) {
    throw new LedgerError('TOO_FEW', 'An expense needs at least two people')
  }
  return ids
}
