import { describe, expect, it } from 'vitest'
import { FX_CURRENCIES, LedgerError, assertRate, convertMinor, currencyName, exponentOf, formatMoney, maxExpenseMinor, fillFromRate, parseMajor, rateText, searchCurrencies } from './index.ts'

describe('multi-currency money', () => {
  it('knows 0-, 2- and 3-decimal currencies', () => {
    expect(exponentOf('JPY')).toBe(0)
    expect(exponentOf('USD')).toBe(2)
    expect(exponentOf('KWD')).toBe(3)
    expect(exponentOf('BHD')).toBe(3)
  })

  it('converts exactly across exponents, half-up', () => {
    // 100.00 EUR at 1.0765 = 107.65 USD
    expect(convertMinor(10000, 'EUR', '1.0765', 'USD')).toBe(10765)
    // ¥15,000 at 0.0066 USD/JPY = $99.00 (0-decimal source into 2-decimal target)
    expect(convertMinor(15000, 'JPY', '0.0066', 'USD')).toBe(9900)
    // $50.00 at 150.5 JPY/USD = ¥7,525 (2-decimal source into 0-decimal target)
    expect(convertMinor(5000, 'USD', '150.5', 'JPY')).toBe(7525)
    // 1.000 KWD at 3.25 USD = $3.25 (3-decimal source)
    expect(convertMinor(1000, 'KWD', '3.25', 'USD')).toBe(325)
    // $3.25 into KWD at 0.3077 = 1.000 KWD (3-decimal target)
    expect(convertMinor(325, 'USD', '0.3077', 'KWD')).toBe(1000)
    // half-up: 0.005 -> 0.01
    expect(convertMinor(1, 'EUR', '0.5', 'USD')).toBe(1)
    expect(convertMinor(1, 'EUR', '0.4999', 'USD')).toBe(0)
    expect(convertMinor(12345, 'USD', '1', 'USD')).toBe(12345)
  })

  it('applies the expense cap to the group currency, so the original amount may exceed it', () => {
    expect(maxExpenseMinor('USD')).toBe(10_000_000)
    expect(maxExpenseMinor('JPY')).toBe(100_000)
    expect(maxExpenseMinor('KWD')).toBe(100_000_000)
    // ¥10,000,000 is far over "100,000" as a number, but is only about $66,000 converted, so entering it uncapped is right.
    expect(() => parseMajor('10000000', 'JPY')).toThrow(LedgerError)
    const yen = parseMajor('10000000', 'JPY', { cap: false })
    expect(yen).toBe(10_000_000)
    expect(convertMinor(yen, 'JPY', '0.0066', 'USD')).toBeLessThan(maxExpenseMinor('USD'))
    expect(() => parseMajor('0', 'JPY', { cap: false })).toThrow(LedgerError)
    expect(() => parseMajor('1.5', 'JPY', { cap: false })).toThrow(/0 decimal/)
    expect(parseMajor('1.234', 'KWD')).toBe(1234)
    expect(() => parseMajor('1.2345', 'KWD')).toThrow(/3 decimal/)
  })

  it('formats 0- and 3-decimal amounts', () => {
    expect(formatMoney(1500, 'JPY')).toContain('1,500')
    expect(formatMoney(1234, 'KWD')).toMatch(/1\.234/)
  })

  it('validates typed rates as plain positive decimals', () => {
    expect(assertRate(' 1.0765 ')).toBe('1.0765')
    for (const bad of ['0', '0.0', '-1', '1e-5', 'abc', '', '1.2.3', '1,5', '0.1234567890123', '1234567890123456789']) {
      expect(() => assertRate(bad), bad).toThrow(LedgerError)
    }
    expect(() => assertRate(1.2)).toThrow(LedgerError)
    expect(() => assertRate(null)).toThrow(LedgerError)
  })

  it('turns JSON numbers into plain decimal text, never exponent form', () => {
    expect(rateText(1.0765)).toBe('1.0765')
    expect(rateText(0.0000071)).toBe('0.0000071')
    expect(rateText(150)).toBe('150')
    expect(() => rateText(0)).toThrow(LedgerError)
    expect(() => rateText(Number.NaN)).toThrow(LedgerError)
    expect(() => rateText(1e12)).toThrow(LedgerError)
  })

  it('fillFromRate converts a foreign expense, and needs a rate for one', () => {
    expect(fillFromRate({ originalMinor: 10000, originalCurrency: 'EUR', groupCurrency: 'USD', rate: '1.0765' })).toEqual({ settlementMinor: 10765, rate: '1.0765', overridden: false })
    expect(fillFromRate({ originalMinor: 10000, originalCurrency: 'USD', groupCurrency: 'USD', rate: null })).toEqual({ settlementMinor: 10000, rate: null, overridden: false })
    expect(() => fillFromRate({ originalMinor: 10000, originalCurrency: 'EUR', groupCurrency: 'USD', rate: null })).toThrow(LedgerError)
  })

  it('lists the picker currencies with USD first and a working search', () => {
    expect(FX_CURRENCIES[0]!.code).toBe('USD')
    expect(new Set(FX_CURRENCIES.map((c) => c.code)).size).toBe(FX_CURRENCIES.length)
    for (const c of FX_CURRENCIES) expect(() => exponentOf(c.code)).not.toThrow()
    expect(currencyName('eur')).toBe('Euro')
    expect(currencyName('xyz')).toBe('XYZ')
    expect(searchCurrencies('yen').map((c) => c.code)).toEqual(['JPY'])
    expect(searchCurrencies('PO').map((c) => c.code)).toContain('GBP')
    expect(searchCurrencies('')).toHaveLength(FX_CURRENCIES.length)
    expect(searchCurrencies('zzzz')).toEqual([])
  })
})
