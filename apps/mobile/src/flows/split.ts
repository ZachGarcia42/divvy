// Design v2 split editor: pure state + validation for the "+ Add expense" sheet (kept out of the UI so it is unit-tested).
// The server is the authority (it re-validates and refuses a split that does not add up); this mirrors it live.
import { allocateByWeights, computeShares, exponentOf, formatMoney, LedgerError, parseMajor, type SplitMethod, type SplitSpec } from '@divvy/domain'

export const METHOD_LABELS: Record<SplitMethod, string> = { equal: 'Equal', exact: 'Exact', percent: '%', shares: 'Shares', adjust: 'Adjust' }
export const METHODS: SplitMethod[] = ['equal', 'exact', 'percent', 'shares', 'adjust']

export type Draft = {
  method: SplitMethod
  included: Record<string, boolean>
  exact: Record<string, string>
  percent: Record<string, string>
  shares: Record<string, number>
  adjust: Record<string, string>
  /**
   * The exact cents a % split was switched over from. While the percents and the amount still match, they are
   * what the split computes to (and what is sent), so Exact 2.51/3.50/2.50/1.50 comes back as the same cents.
   */
  percentCarry?: { total: number; bps: Record<string, number>; minors: Record<string, number> }
}

export type Bar = { tone: 'ok' | 'bad' | 'idle'; left: string; right: string }
export type Evaluation = {
  ok: boolean
  /** Minor units per person (empty when the split cannot be computed yet). */
  results: Record<string, number>
  bar: Bar
  /** What goes to the API; null while invalid. */
  spec: SplitSpec | null
  /** Label for the bottom button. */
  cta: string
}

export function majorString(minor: number, currency: string) {
  const exp = exponentOf(currency)
  const scale = 10 ** exp
  const abs = Math.abs(minor)
  const fraction = exp === 0 ? '' : `.${String(abs % scale).padStart(exp, '0')}`
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / scale)}${fraction}`
}

/** `majorString` with thousands separators, for showing an amount at rest: 4886224 → "48,862.24". */
export function groupedMajor(minor: number, currency: string) {
  const [whole = '', fraction] = majorString(minor, currency).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

const blank = (ids: string[], value: string) => Object.fromEntries(ids.map((id) => [id, value]))

/** Equal by default, everyone included. */
export function newDraft(memberIds: string[]): Draft {
  return {
    method: 'equal',
    included: Object.fromEntries(memberIds.map((id) => [id, true])),
    exact: blank(memberIds, ''),
    percent: blank(memberIds, ''),
    shares: Object.fromEntries(memberIds.map((id) => [id, 1])),
    adjust: blank(memberIds, ''),
  }
}

/** A share or adjustment: blank is 0, a leading + or - is allowed when `signed`. Throws on junk. */
export function parseAmountText(input: string, currency: string, signed: boolean): number {
  let text = input.trim()
  if (!text) return 0
  let sign = 1
  if (signed && /^[+\-−]/.test(text)) {
    sign = text.startsWith('+') ? 1 : -1
    text = text.slice(1).trim()
    if (!text) return 0
  }
  if (/^0+(\.0+)?$/.test(text)) return 0
  return sign * parseMajor(text, currency)
}

/** "33.33" -> 3333 basis points; blank is 0; null when it is not a percent with at most two decimals. */
export function parsePercentBps(input: string): number | null {
  const text = input.trim().replace(/%$/, '').trim()
  if (!text) return 0
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  return Math.round(Number(text) * 100)
}

export function bpsText(bps: number) {
  const text = (bps / 100).toFixed(2)
  return text.replace(/\.?0+$/, '')
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function totalOf(amountText: string, currency: string): number | null {
  try { return parseMajor(amountText, currency) } catch { return null }
}

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b) }

/** Whole-number shares that reproduce `weights` (reduced; falls back to whole percents when that gets unwieldy). */
export function sharesFromWeights(weights: number[]): number[] {
  const positive = weights.filter((w) => w > 0)
  if (positive.length === 0) return weights.map(() => 1)
  const lo = Math.min(...positive)
  const hi = Math.max(...positive)
  if (hi - lo <= 2) return weights.map((w) => (w > 0 ? 1 : 0))
  const g = positive.reduce(gcd)
  const reduced = weights.map((w) => w / g)
  if (Math.max(...reduced) <= 100) return reduced
  const total = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => (w > 0 ? Math.max(1, Math.round((w / total) * 100)) : 0))
}

/**
 * Whole shares for the target: the tidy ones from `sharesFromWeights` when they reproduce the source cents, else the
 * cents themselves as weights (their sum is the total, so every share is exactly its own cents).
 */
function sharesCarrying(weights: number[], memberIds: string[], known: Record<string, number> | null, total: number | null, payerId: string | null): Record<string, number> {
  const tidy = sharesFromWeights(weights)
  const asDraft = Object.fromEntries(memberIds.map((id, i) => [id, tidy[i]!]))
  if (!known || total === null) return asDraft
  const parts = memberIds.map((id, i) => ({ participantId: id, weight: tidy[i]! })).filter((row) => row.weight > 0)
  try {
    const got = computeShares(total, { type: 'shares', parts }, undefined, { payerId })
    const same = memberIds.every((id) => (got.find((row) => row.participantId === id)?.minor ?? 0) === (known[id] ?? 0))
    if (same) return asDraft
  } catch { return asDraft }
  // total * weight must stay a safe integer for the server's arithmetic.
  if (total * total > Number.MAX_SAFE_INTEGER) return asDraft
  return Object.fromEntries(memberIds.map((id) => [id, known[id] ?? 0]))
}

/** Compute what each person owes under the current method, or say what is wrong. */
export function evaluate(draft: Draft, memberIds: string[], amountText: string, currency: string, payerId: string | null, nameOf: (id: string) => string = (id) => id): Evaluation {
  const total = totalOf(amountText, currency)
  const money = (minor: number) => formatMoney(minor, currency)
  const idle = (left: string): Evaluation => ({ ok: false, results: {}, bar: { tone: 'idle', left, right: '' }, spec: null, cta: 'Enter an amount' })
  const bad = (left: string, right: string, results: Record<string, number> = {}): Evaluation => ({ ok: false, results, bar: { tone: 'bad', left, right }, spec: null, cta: 'Fix the split to save' })
  const done = (spec: SplitSpec, left: string): Evaluation => {
    const rows = computeShares(total as number, spec, currency, { payerId })
    return { ok: true, results: Object.fromEntries(rows.map((row) => [row.participantId, row.minor])), bar: { tone: 'ok', left, right: '✓ Adds up' }, spec, cta: 'Add expense' }
  }
  if (draft.method === 'equal') {
    const ids = memberIds.filter((id) => draft.included[id])
    if (ids.length === 0) return bad('No one is included', 'Pick at least one person')
    if (total === null) return idle(`${plural(ids.length, 'person', 'people')} included`)
    const spec: SplitSpec = { type: 'equal', participantIds: ids }
    const rows = computeShares(total, spec, currency, { payerId })
    const base = Math.floor(total / ids.length)
    const extra = rows.filter((row) => row.minor > base).map((row) => nameOf(row.participantId))
    const note = extra.length ? ` · +${money(1)} to ${extra.join(', ')}` : ''
    return done(spec, `${money(base)} each · ${plural(ids.length, 'person', 'people')}${note}`)
  }
  if (draft.method === 'exact') {
    const amounts: { participantId: string; minor: number }[] = []
    for (const id of memberIds) {
      try { amounts.push({ participantId: id, minor: parseAmountText(draft.exact[id] ?? '', currency, false) }) } catch (reason) {
        return bad('Check the amounts', reason instanceof Error ? reason.message : 'Not an amount')
      }
    }
    const sum = amounts.reduce((acc, row) => acc + row.minor, 0)
    if (total === null) return idle(`${money(sum)} entered`)
    const results = Object.fromEntries(amounts.map((row) => [row.participantId, row.minor]))
    if (sum !== total) {
      const gap = total - sum
      return bad(`${money(sum)} of ${money(total)}`, gap > 0 ? `${money(gap)} left` : `${money(-gap)} over`, results)
    }
    return done({ type: 'exact', amounts: amounts.filter((row) => row.minor > 0) }, `${money(sum)} of ${money(total)}`)
  }
  if (draft.method === 'percent') {
    const parts: { participantId: string; bps: number }[] = []
    for (const id of memberIds) {
      const bps = parsePercentBps(draft.percent[id] ?? '')
      if (bps === null) return bad('Check the percents', 'Use up to two decimals')
      parts.push({ participantId: id, bps })
    }
    const sum = parts.reduce((acc, row) => acc + row.bps, 0)
    if (sum !== 10_000) {
      const gap = 10_000 - sum
      return bad(`${bpsText(sum) || '0'}% of 100%`, gap > 0 ? `${bpsText(gap)}% left` : `${bpsText(-gap)}% over`)
    }
    if (total === null) return idle('100% of 100%')
    const carry = draft.percentCarry
    if (carry && carry.total === total && parts.every((row) => row.bps === (carry.bps[row.participantId] ?? 0))) {
      const carried = parts.map((row) => ({ ...row, minor: carry.minors[row.participantId] ?? 0 })).filter((row) => row.bps > 0 || row.minor > 0)
      return done({ type: 'percent', parts: carried }, '100% of 100%')
    }
    return done({ type: 'percent', parts: parts.filter((row) => row.bps > 0) }, '100% of 100%')
  }
  if (draft.method === 'shares') {
    const parts = memberIds.map((id) => ({ participantId: id, weight: Math.max(0, Math.floor(draft.shares[id] ?? 0)) }))
    const sum = parts.reduce((acc, row) => acc + row.weight, 0)
    if (sum === 0) return bad('0 shares', 'Give someone a share')
    if (total === null) return idle(`${plural(sum, 'share')}`)
    const per = Math.floor(total / sum)
    return done({ type: 'shares', parts: parts.filter((row) => row.weight > 0) }, `${plural(sum, 'share')} · ${money(per)} per share`)
  }
  // adjust
  const parts: { participantId: string; minor: number }[] = []
  for (const id of memberIds) {
    try { parts.push({ participantId: id, minor: parseAmountText(draft.adjust[id] ?? '', currency, true) }) } catch (reason) {
      return bad('Check the adjustments', reason instanceof Error ? reason.message : 'Not an amount')
    }
  }
  const adjusted = parts.reduce((acc, row) => acc + row.minor, 0)
  if (total === null) return idle(`${money(adjusted)} adjusted`)
  const spec: SplitSpec = { type: 'adjust', parts }
  try {
    const rows = computeShares(total, spec, currency, { payerId })
    const rest = total - adjusted
    const results = Object.fromEntries(rows.map((row) => [row.participantId, row.minor]))
    return { ok: true, results, bar: { tone: 'ok', left: `${money(rest)} split ${memberIds.length} ways${adjusted ? ` + ${money(adjusted)}` : ''}`, right: '✓ Adds up' }, spec, cta: 'Add expense' }
  } catch (reason) {
    if (!(reason instanceof LedgerError)) throw reason
    const rest = total - adjusted
    if (rest < 0) return bad(`Adjustments ${money(adjusted)}`, `${money(-rest)} over total`)
    return bad('Someone would owe less than zero', 'Lower an adjustment')
  }
}

/** The weights the current split stands for: its computed amounts, or an even split of whoever is included. */
function currentWeights(draft: Draft, memberIds: string[], results: Record<string, number> | null) {
  if (results && Object.keys(results).length) return memberIds.map((id) => results[id] ?? 0)
  if (draft.method === 'equal') return memberIds.map((id) => (draft.included[id] ? 1 : 0))
  return memberIds.map(() => 1)
}

/**
 * Switch methods carrying the current split over (Equal $40/$40/$40 becomes Exact 40/40/40) instead of resetting.
 * Only a valid, computed split carries amounts; otherwise the target method keeps what you already typed there.
 */
export function switchMethod(draft: Draft, to: SplitMethod, memberIds: string[], amountText: string, currency: string, payerId: string | null): Draft {
  if (to === draft.method) return draft
  const evaluation = evaluate(draft, memberIds, amountText, currency, payerId)
  const total = totalOf(amountText, currency)
  const known = evaluation.ok ? evaluation.results : null
  const weights = currentWeights(draft, memberIds, known)
  const next: Draft = { ...draft, method: to }
  const sumW = weights.reduce((a, b) => a + b, 0)
  // A half-typed or invalid split in another method does not carry: the target keeps what is already there.
  if (!known && draft.method !== 'equal') return next
  if (to === 'equal') {
    const any = weights.some((w) => w > 0)
    next.included = Object.fromEntries(memberIds.map((id, i) => [id, any ? weights[i]! > 0 : true]))
  } else if (to === 'exact') {
    if (known) next.exact = Object.fromEntries(memberIds.map((id) => [id, known[id] ? majorString(known[id], currency) : '']))
    else if (total !== null) {
      const even = allocateByWeights(total, memberIds.map((id, i) => ({ id, weight: weights[i]! })), payerId ? [payerId, ...memberIds] : memberIds)
      next.exact = Object.fromEntries(even.map((row) => [row.id, row.minor ? majorString(row.minor, currency) : '']))
    }
  } else if (to === 'percent') {
    if (sumW > 0) {
      const rows = allocateByWeights(10_000, memberIds.map((id, i) => ({ id, weight: weights[i]! })), memberIds)
      next.percent = Object.fromEntries(rows.map((row) => [row.id, row.minor ? bpsText(row.minor) : '']))
      // Two decimals of percent cannot always say which cent went where, so a valid split brings its cents along.
      if (known && total !== null) {
        next.percentCarry = { total, bps: Object.fromEntries(rows.map((row) => [row.id, row.minor])), minors: Object.fromEntries(memberIds.map((id) => [id, known[id] ?? 0])) }
      } else delete next.percentCarry
    }
  } else if (to === 'shares') {
    next.shares = sharesCarrying(weights, memberIds, known, total, payerId)
  } else {
    // adjust: an even split carries as all zeros; an uneven one as offsets from the even base, which reproduces it exactly.
    if (known && total !== null) {
      const amounts = memberIds.map((id) => known[id] ?? 0)
      const spread = Math.max(...amounts) - Math.min(...amounts)
      const evenSplit = allocateByWeights(total, memberIds.map((id) => ({ id, weight: 1 })), payerId ? [payerId, ...memberIds] : memberIds)
      // Blank adjustments mean "an even split", which only reproduces the cents when the leftover cent lands on the same people.
      if (spread <= 1 && evenSplit.every((row, i) => row.minor === amounts[i])) next.adjust = blank(memberIds, '')
      else {
        const base = Math.floor(total / memberIds.length)
        next.adjust = Object.fromEntries(memberIds.map((id, i) => {
          const adj = amounts[i]! - base
          return [id, adj === 0 ? '' : `${adj > 0 ? '+' : '-'}${majorString(Math.abs(adj), currency)}`]
        }))
      }
    }
  }
  return next
}

/** Back from a stored split (editing an expense) into the editor. */
export function draftFromSpec(spec: SplitSpec | null, memberIds: string[], currency: string): Draft {
  const draft = newDraft(memberIds)
  if (!spec) return draft
  draft.method = spec.type
  if (spec.type === 'equal') draft.included = Object.fromEntries(memberIds.map((id) => [id, spec.participantIds.includes(id)]))
  else if (spec.type === 'exact') draft.exact = Object.fromEntries(memberIds.map((id) => { const row = spec.amounts.find((r) => r.participantId === id); return [id, row && row.minor ? majorString(row.minor, currency) : ''] }))
  else if (spec.type === 'percent') draft.percent = Object.fromEntries(memberIds.map((id) => { const row = spec.parts.find((r) => r.participantId === id); return [id, row && row.bps ? bpsText(row.bps) : ''] }))
  else if (spec.type === 'shares') draft.shares = Object.fromEntries(memberIds.map((id) => [id, spec.parts.find((r) => r.participantId === id)?.weight ?? 0]))
  else draft.adjust = Object.fromEntries(memberIds.map((id) => { const row = spec.parts.find((r) => r.participantId === id); return [id, row && row.minor ? `${row.minor > 0 ? '+' : '-'}${majorString(Math.abs(row.minor), currency)}` : ''] }))
  if (spec.type === 'percent' && spec.parts.length > 0 && spec.parts.every((r) => typeof r.minor === 'number')) {
    draft.percentCarry = {
      total: spec.parts.reduce((acc, r) => acc + (r.minor as number), 0),
      bps: Object.fromEntries(spec.parts.map((r) => [r.participantId, r.bps])),
      minors: Object.fromEntries(spec.parts.map((r) => [r.participantId, r.minor as number])),
    }
  }
  return draft
}

/** "Discard expense?" only when there is something to lose. */
export function isDirty(amountText: string, description: string, draft: Draft, memberIds: string[]) {
  return !!amountText.trim() || !!description.trim() || JSON.stringify(draft) !== JSON.stringify(newDraft(memberIds))
}
