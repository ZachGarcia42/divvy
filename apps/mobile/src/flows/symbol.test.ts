import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { symbolOf } from './symbol'

const proto = Intl.NumberFormat.prototype as unknown as { formatToParts?: unknown }
const CODES = ['USD', 'CAD', 'SEK', 'JPY', 'EUR', 'GBP', 'CNY', 'KWD']

describe('symbolOf (amount prefixes, picker tiles)', () => {
  it('with formatToParts (Android, web) the signs are unchanged', () => {
    expect(CODES.map(symbolOf)).toEqual(['$', 'CA$', 'SEK', '¥', '€', '£', 'CN¥', 'KWD'])
  })

  describe('without Intl.NumberFormat.formatToParts (Hermes on iOS)', () => {
    let saved: unknown
    let reference: string[]
    beforeEach(() => {
      reference = CODES.map(symbolOf)
      saved = proto.formatToParts
      delete proto.formatToParts
    })
    afterEach(() => { proto.formatToParts = saved })

    it('still shows the sign, not the code', () => {
      expect(typeof proto.formatToParts).toBe('undefined')
      expect(symbolOf('USD')).toBe('$')
      expect(symbolOf('CAD')).toBe('CA$')
      expect(symbolOf('SEK')).toBe('SEK')
      expect(symbolOf('JPY')).toBe('¥')
    })
    it('matches the formatToParts result for every code checked', () => {
      expect(CODES.map(symbolOf)).toEqual(reference)
    })
  })

  it('falls back to the code when Intl throws', () => {
    const RealNF = Intl.NumberFormat
    ;(Intl as unknown as { NumberFormat: unknown }).NumberFormat = function () { throw new RangeError('nope') }
    try { expect(symbolOf('USD')).toBe('USD') } finally { (Intl as unknown as { NumberFormat: unknown }).NumberFormat = RealNF }
  })
})
