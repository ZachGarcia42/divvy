import { describe, expect, it } from 'vitest'
import { allocateByWeights, computeShares, splitFromStored, splitToStored, type SplitSpec } from './index.ts'

const sum = (rows: { minor: number }[]) => rows.reduce((acc, row) => acc + row.minor, 0)
const byId = (rows: { participantId: string; minor: number }[]) => Object.fromEntries(rows.map((row) => [row.participantId, row.minor]))

describe('split methods (design v2)', () => {
  it('equal: $100 three ways gives the extra cent to the payer, not the lowest id', () => {
    const spec: SplitSpec = { type: 'equal', participantIds: ['a', 'b', 'c'] }
    expect(byId(computeShares(10000, spec, 'USD', { payerId: 'c' }))).toEqual({ a: 3333, b: 3333, c: 3334 })
    // Legacy callers (no options) keep the old largest-remainder / lowest id rule.
    expect(byId(computeShares(10000, spec, 'USD'))).toEqual({ a: 3334, b: 3333, c: 3333 })
  })

  it('equal: two leftover cents go to the payer first, then member order', () => {
    const spec: SplitSpec = { type: 'equal', participantIds: ['a', 'b', 'c', 'd'] }
    // 1002 / 4 = 250 r2 -> payer c, then a
    expect(byId(computeShares(1002, spec, 'USD', { payerId: 'c' }))).toEqual({ a: 251, b: 250, c: 251, d: 250 })
  })

  it('a payer who is not in the split changes nothing: leftover goes in member order', () => {
    const spec: SplitSpec = { type: 'equal', participantIds: ['a', 'b', 'c'] }
    expect(byId(computeShares(1000, spec, 'USD', { payerId: 'z' }))).toEqual({ a: 334, b: 333, c: 333 })
  })

  it('percent and shares round the same way and always add to the total', () => {
    const pct: SplitSpec = { type: 'percent', parts: [{ participantId: 'a', bps: 3333 }, { participantId: 'b', bps: 3333 }, { participantId: 'c', bps: 3334 }] }
    for (const total of [1, 2, 99, 100, 101, 9999, 10001, 123457]) {
      expect(sum(computeShares(total, pct, 'USD', { payerId: 'b' }))).toBe(total)
    }
    const shares: SplitSpec = { type: 'shares', parts: [{ participantId: 'a', weight: 1 }, { participantId: 'b', weight: 2 }, { participantId: 'c', weight: 0 }] }
    // 1000 * 1/3 = 333.33, 666.66: floors 333 + 666, one leftover cent -> payer b
    expect(byId(computeShares(1000, shares, 'USD', { payerId: 'b' }))).toEqual({ a: 333, b: 667, c: 0 })
    // a zero-weight person never gets a leftover cent, even when they pay
    expect(byId(computeShares(1000, shares, 'USD', { payerId: 'c' }))).toEqual({ a: 334, b: 666, c: 0 })
  })

  it('exact must add up, with the gap in the message', () => {
    const spec: SplitSpec = { type: 'exact', amounts: [{ participantId: 'a', minor: 600 }, { participantId: 'b', minor: 300 }] }
    expect(() => computeShares(1000, spec, 'USD', { payerId: 'a' })).toThrow('$1.00 left')
    expect(byId(computeShares(900, spec, 'USD', { payerId: 'a' }))).toEqual({ a: 600, b: 300 })
  })

  it('adjust: $120 with Leo +$10 is $27.50 each for three and $37.50 for Leo', () => {
    const spec: SplitSpec = { type: 'adjust', parts: [
      { participantId: 'you', minor: 0 }, { participantId: 'maya', minor: 0 }, { participantId: 'priya', minor: 0 }, { participantId: 'leo', minor: 1000 },
    ] }
    expect(byId(computeShares(12000, spec, 'USD', { payerId: 'you' }))).toEqual({ you: 2750, maya: 2750, priya: 2750, leo: 3750 })
  })

  it('adjust: negative adjustments work as long as nobody ends up below zero', () => {
    const ok: SplitSpec = { type: 'adjust', parts: [{ participantId: 'a', minor: -500 }, { participantId: 'b', minor: 0 }] }
    // rest = 1500, 750 each: a ends at 250, b at 750
    expect(byId(computeShares(1000, ok, 'USD'))).toEqual({ a: 250, b: 750 })
    const bad: SplitSpec = { type: 'adjust', parts: [{ participantId: 'a', minor: -900 }, { participantId: 'b', minor: 0 }] }
    // rest = 1900, 950 each: a ends at 50 - fine; push further
    expect(sum(computeShares(1000, bad, 'USD'))).toBe(1000)
    const negative: SplitSpec = { type: 'adjust', parts: [{ participantId: 'a', minor: -2000 }, { participantId: 'b', minor: 0 }] }
    // rest = 3000, 1500 each: a ends at -500
    expect(() => computeShares(1000, negative, 'USD')).toThrow('negative')
  })

  it('adjust: adjustments over the total are refused and say by how much', () => {
    const spec: SplitSpec = { type: 'adjust', parts: [
      { participantId: 'a', minor: 0 }, { participantId: 'b', minor: 5000 }, { participantId: 'c', minor: 6000 }, { participantId: 'd', minor: 2000 },
    ] }
    expect(() => computeShares(12000, spec, 'USD')).toThrow('Over by $10.00')
  })

  it('adjust: the odd cent after adjustments goes to the payer first', () => {
    const spec: SplitSpec = { type: 'adjust', parts: [{ participantId: 'a', minor: 0 }, { participantId: 'b', minor: 0 }, { participantId: 'c', minor: 100 }] }
    // rest = 900 -> 300 each -> a 300, b 300, c 400; with 1001 total rest = 901 -> 301/300/300, payer b gets the cent
    expect(byId(computeShares(1001, spec, 'USD', { payerId: 'b' }))).toEqual({ a: 300, b: 301, c: 400 })
  })

  it('adjust rejects duplicates, fractions and empty lists', () => {
    expect(() => computeShares(1000, { type: 'adjust', parts: [] }, 'USD')).toThrow()
    expect(() => computeShares(1000, { type: 'adjust', parts: [{ participantId: 'a', minor: 0 }, { participantId: 'a', minor: 0 }] }, 'USD')).toThrow('twice')
    expect(() => computeShares(1000, { type: 'adjust', parts: [{ participantId: 'a', minor: 0.5 }] }, 'USD')).toThrow()
    expect(() => computeShares(1000, { type: 'adjust' } as unknown as SplitSpec, 'USD')).toThrow('Choose how to split')
  })

  it('allocateByWeights with a priority list never over-hands a cent', () => {
    for (let total = 0; total < 60; total += 1) {
      const rows = allocateByWeights(total, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }, { id: 'd', weight: 0 }], ['d', 'c'])
      expect(sum(rows)).toBe(total)
      expect(rows.find((row) => row.id === 'd')!.minor).toBe(0)
    }
  })

  it('stores a split as method + raw inputs and reads it back, ignoring junk', () => {
    const spec: SplitSpec = { type: 'percent', parts: [{ participantId: 'a', bps: 7000 }, { participantId: 'b', bps: 3000 }] }
    const stored = splitToStored(spec)
    expect(stored).toEqual({ method: 'percent', inputs: { parts: spec.parts } })
    expect(splitFromStored(stored.method, JSON.stringify(stored.inputs))).toEqual(spec)
    const adjust = splitToStored({ type: 'adjust', parts: [{ participantId: 'a', minor: -5 }] })
    expect(splitFromStored(adjust.method, adjust.inputs)).toEqual({ type: 'adjust', parts: [{ participantId: 'a', minor: -5 }] })
    expect(splitFromStored('equal', '{"participantIds":["a","b"]}')).toEqual({ type: 'equal', participantIds: ['a', 'b'] })
    expect(splitFromStored(null, null)).toBeNull()
    expect(splitFromStored('percent', 'not json')).toBeNull()
    expect(splitFromStored('shares', '{"nope":1}')).toBeNull()
    expect(splitFromStored('zzz', '{}')).toBeNull()
  })
})
