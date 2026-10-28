import { LedgerError, assertMinor, formatMoney } from './money.ts'
import { shareGapMessage } from './labels.ts'

export type Weighted = { id: string; weight: number }

/**
 * Split `total` minor units by weight. Leftover units go to the largest fractional remainders, ties by id.
 * With `priority` (design v2) the leftover units instead go one each to the people with a positive weight
 * in that order, then in the order the weights were listed.
 */
export function allocateByWeights(total: number, weights: Weighted[], priority?: string[]): { id: string; minor: number }[] {
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
  const order = priority
    ? leftoverOrder(staged.filter((row, index) => rows[index]!.weight > 0), priority)
    : [...staged].sort((a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : 1))
  for (const row of order) {
    if (left === 0) break
    row.minor += 1
    left -= 1
  }
  return staged.map((row) => ({ id: row.id, minor: row.minor }))
}

function leftoverOrder<T extends { id: string }>(rows: T[], priority: string[]): T[] {
  const rank = (id: string) => {
    const at = priority.indexOf(id)
    return at === -1 ? priority.length : at
  }
  // Array.prototype.sort is stable, so people outside `priority` keep the order they were listed in.
  return [...rows].sort((a, b) => rank(a.id) - rank(b.id))
}

export type SplitMethod = 'equal' | 'exact' | 'percent' | 'shares' | 'adjust'
export const SPLIT_METHODS: SplitMethod[] = ['equal', 'exact', 'percent', 'shares', 'adjust']

/**
 * `adjust` (design v2): each person has a signed adjustment in minor units on top of an equal split of what is
 * left after the adjustments, e.g. $120 with Leo +$10 is Leo $37.50 and the other three $27.50.
 */
export type SplitSpec =
  | { type: 'equal'; participantIds: string[] }
  | { type: 'exact'; amounts: { participantId: string; minor: number }[] }
  | { type: 'percent'; parts: { participantId: string; bps: number; minor?: number }[] }
  | { type: 'shares'; parts: { participantId: string; weight: number }[] }
  | { type: 'adjust'; parts: { participantId: string; minor: number }[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const rowsOk = (rows: unknown, key: string, kind: 'string' | 'number') =>
  Array.isArray(rows) && rows.every((row) => isObj(row) && typeof row.participantId === 'string' && typeof row[key] === kind)

/** Rejects a split whose shape doesn't match its type (it comes straight from request JSON). */
export function assertSplitShape(spec: unknown): asserts spec is SplitSpec {
  const bad = () => new LedgerError('BAD_SPLIT', 'Choose how to split this')
  if (!isObj(spec)) throw bad()
  if (spec.type === 'equal') {
    if (!Array.isArray(spec.participantIds) || !spec.participantIds.every((id) => typeof id === 'string')) throw bad()
  } else if (spec.type === 'exact') {
    // A blank share (null, missing or '') counts as 0, so it fails the add-up check with "$x left" instead.
    if (!Array.isArray(spec.amounts)) throw bad()
    for (const row of spec.amounts) {
      if (isObj(row) && (row.minor === null || row.minor === undefined || row.minor === '')) row.minor = 0
    }
    if (!rowsOk(spec.amounts, 'minor', 'number')) throw bad()
  } else if (spec.type === 'percent') {
    if (!rowsOk(spec.parts, 'bps', 'number')) throw bad()
  } else if (spec.type === 'shares') {
    if (!rowsOk(spec.parts, 'weight', 'number')) throw bad()
  } else if (spec.type === 'adjust') {
    if (!Array.isArray(spec.parts)) throw bad()
    for (const row of spec.parts) {
      if (isObj(row) && (row.minor === null || row.minor === undefined || row.minor === '')) row.minor = 0
    }
    if (!rowsOk(spec.parts, 'minor', 'number')) throw bad()
  } else {
    throw bad()
  }
}

export type ComputeOptions = {
  /**
   * Design v2 rounding: the leftover cents go to the payer first, then down the list in member order.
   * Without it the leftover cents follow the legacy rule (largest remainder, ties by id).
   */
  payerId?: string | null
}

/** The people who get a leftover cent first: the payer, then everyone in the order the split lists them. */
function priorityFor(spec: SplitSpec, options?: ComputeOptions): string[] | undefined {
  if (!options || options.payerId === undefined) return undefined
  const ids = spec.type === 'equal' ? spec.participantIds
    : spec.type === 'exact' ? spec.amounts.map((row) => row.participantId)
      : spec.parts.map((row) => row.participantId)
  return options.payerId ? [options.payerId, ...ids] : ids
}

/**
 * A percent split may carry the exact cents it was built from (switching Exact $2.51/$3.50/... to % must not move
 * a cent). They are honoured only when they add up to the total and each one agrees with its percent to within
 * one basis point of the total, i.e. they are a rounding of the percents, never a different split.
 */
function carriedPercentMinors(totalMinor: number, parts: { participantId: string; bps: number; minor?: number }[]) {
  const given = parts.filter((row) => row.minor !== undefined && row.minor !== null)
  if (given.length === 0) return null
  const bad = () => new LedgerError('BAD_SPLIT', 'Those amounts do not match the percents')
  if (given.length !== parts.length) throw bad()
  let sum = 0
  for (const row of parts) {
    const minor = row.minor as number
    if (!Number.isInteger(minor) || minor < 0) throw bad()
    if (Math.abs(minor * 10_000 - totalMinor * row.bps) >= Math.max(1, totalMinor)) throw bad()
    sum += minor
  }
  if (sum !== totalMinor) throw bad()
  return parts.map((row) => ({ participantId: row.participantId, minor: row.minor as number }))
}

export function computeShares(totalMinor: number, spec: SplitSpec, currency?: string, options?: ComputeOptions): { participantId: string; minor: number }[] {
  assertMinor(totalMinor, 'Total')
  assertSplitShape(spec)
  const priority = priorityFor(spec, options)
  if (spec.type === 'equal') {
    if (spec.participantIds.length === 0) {
      throw new LedgerError('BAD_SPLIT', 'Choose at least one person')
    }
    return allocateByWeights(
      totalMinor,
      spec.participantIds.map((id) => ({ id, weight: 1 })),
      priority,
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
      throw new LedgerError('UNBALANCED', (currency && shareGapMessage(sum, totalMinor, currency)) || 'Exact shares must add up to the total')
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
    const carried = carriedPercentMinors(totalMinor, spec.parts)
    if (carried) return carried
    return allocateByWeights(
      totalMinor,
      spec.parts.map((row) => ({ id: row.participantId, weight: row.bps })),
      priority,
    ).map((row) => ({ participantId: row.id, minor: row.minor }))
  }
  if (spec.type === 'adjust') {
    if (spec.parts.length === 0) throw new LedgerError('BAD_SPLIT', 'Choose at least one person')
    spec.parts.forEach((row) => assertMinor(row.minor, 'Adjustment'))
    assertUnique(spec.parts.map((row) => row.participantId))
    const adjusted = spec.parts.reduce((acc, row) => acc + row.minor, 0)
    const rest = totalMinor - adjusted
    if (rest < 0) {
      const over = currency ? ` ${formatMoney(-rest, currency)}` : ''
      throw new LedgerError('UNBALANCED', `Adjustments add up to more than the total.${over ? ` Over by${over}.` : ''}`)
    }
    const even = allocateByWeights(rest, spec.parts.map((row) => ({ id: row.participantId, weight: 1 })), priority)
    const out = spec.parts.map((row, index) => ({ participantId: row.participantId, minor: row.minor + even[index]!.minor }))
    if (out.some((row) => row.minor < 0)) throw new LedgerError('BAD_SPLIT', 'Shares cannot be negative')
    return out
  }
  if (spec.parts.some((row) => !Number.isInteger(row.weight) || row.weight < 0)) {
    throw new LedgerError('BAD_SPLIT', 'Shares must be zero or a positive integer')
  }
  assertUnique(spec.parts.map((row) => row.participantId))
  return allocateByWeights(
    totalMinor,
    spec.parts.map((row) => ({ id: row.participantId, weight: row.weight })),
    priority,
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

/** What a split is stored as: its method plus the raw inputs the person typed (so an edit reopens as they left it). */
export function splitToStored(spec: SplitSpec): { method: SplitMethod; inputs: unknown } {
  switch (spec.type) {
    case 'equal': return { method: 'equal', inputs: { participantIds: spec.participantIds } }
    case 'exact': return { method: 'exact', inputs: { amounts: spec.amounts } }
    default: return { method: spec.type, inputs: { parts: spec.parts } }
  }
}

/** Rebuilds the split from what `splitToStored` saved. Returns null when the stored value is missing or unusable. */
export function splitFromStored(method: string | null | undefined, inputs: unknown): SplitSpec | null {
  let raw = inputs
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return null }
  }
  if (!method || !isObj(raw)) return null
  const spec = { type: method, ...raw } as unknown
  try {
    assertSplitShape(spec)
    return spec
  } catch {
    return null
  }
}
