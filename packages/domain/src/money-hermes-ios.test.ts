import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FX_CURRENCIES } from './currencies.ts'
import { currencySymbol, formatMoney } from './money.ts'

// iOS crash 2026-11-21: Hermes on Apple platforms does not define Intl.NumberFormat.prototype.formatToParts
// (hermes lib/VM/JSLib/Intl.cpp: `#ifndef __APPLE__` around it). formatMoney called it unguarded, so the first
// screen that printed money (Group spend $0.00 on a new group) threw "formatToParts is not a function" and the
// release build crashed, then crash-looped because the app reopens the last group at launch.
const proto = Intl.NumberFormat.prototype as unknown as { formatToParts?: unknown }
let saved: unknown
const expected = (code: string) => {
  const real = currencySymbol(code)
  return real
}

describe('formatMoney without Intl.NumberFormat.formatToParts (Hermes on iOS)', () => {
  let reference: Map<string, string>
  beforeEach(() => {
    reference = new Map(FX_CURRENCIES.map(({ code }) => [code, expected(code)]))
    saved = proto.formatToParts
    delete proto.formatToParts
  })
  afterEach(() => { proto.formatToParts = saved })

  it('formats a new empty group\'s spend instead of throwing', () => {
    expect(typeof proto.formatToParts).toBe('undefined')
    expect(() => formatMoney(0, 'USD')).not.toThrow()
    expect(formatMoney(0, 'USD')).toBe('$0.00')
    expect(formatMoney(1050, 'USD')).toBe('$10.50')
    expect(formatMoney(-500, 'cad')).toBe('-CA$5.00')
    expect(formatMoney(1200, 'SEK')).toBe('SEK 12.00')
    expect(formatMoney(1500, 'JPY')).toBe('¥1,500')
  })

  it('gives every offered currency the same symbol as when formatToParts exists', () => {
    for (const { code } of FX_CURRENCIES) expect(currencySymbol(code), code).toBe(reference.get(code))
  })

  it('falls back to the currency code if Intl itself throws', () => {
    const RealNF = Intl.NumberFormat
    ;(Intl as unknown as { NumberFormat: unknown }).NumberFormat = function () { throw new RangeError('nope') }
    try {
      expect(currencySymbol('USD')).toBe('USD')
      expect(formatMoney(1050, 'USD')).toBe('USD 10.50')
    } finally {
      ;(Intl as unknown as { NumberFormat: unknown }).NumberFormat = RealNF
    }
  })
})
