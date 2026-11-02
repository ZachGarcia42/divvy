import { describe, expect, it } from 'vitest'
import { amountPlaceholder, conversionLines, isForeign, manualRateOrNull, originalText, rateLabel, rateSourceText, sheetMoney } from './fx'
import { historyLines } from './view'

describe('amounts in another currency', () => {
  it('converts what was typed with the rate, in minor units', () => {
    expect(sheetMoney('100', 'EUR', 'USD', '1.0765')).toEqual({ original: 10000, converted: 10765, error: null })
    expect(sheetMoney('15000', 'JPY', 'USD', '0.0066')).toEqual({ original: 15000, converted: 9900, error: null })
    expect(sheetMoney('50', 'USD', 'JPY', '150.5')).toEqual({ original: 5000, converted: 7525, error: null })
    expect(sheetMoney('1.234', 'KWD', 'USD', '3.25')).toEqual({ original: 1234, converted: 401, error: null })
  })
  it('waits for a rate, and says nothing before an amount is typed', () => {
    expect(sheetMoney('100', 'EUR', 'USD', null)).toEqual({ original: 10000, converted: null, error: null })
    expect(sheetMoney('', 'EUR', 'USD', '1.1')).toEqual({ original: null, converted: null, error: null })
  })
  it('a same-currency amount keeps the $100,000 limit; a foreign one is limited after conversion', () => {
    expect(sheetMoney('100001', 'USD', 'USD', null).converted).toBeNull()
    // ¥10,000,000 is fine to type (about $66,000); it is the converted amount the server limits
    expect(sheetMoney('10000000', 'JPY', 'USD', '0.0066').converted).toBe(6_600_000)
    expect(sheetMoney('20000000', 'JPY', 'USD', '0.0066').converted).toBe(13_200_000) // over the cap: the sheet's split bar reports it
  })
  it('explains an amount the currency cannot hold', () => {
    expect(sheetMoney('10.5', 'JPY', 'USD', '0.0066').error).toBe('JPY uses 0 decimal places')
    expect(sheetMoney('1.2345', 'KWD', 'USD', '3.25').error).toBe('KWD uses 3 decimal places')
    expect(sheetMoney('0', 'EUR', 'USD', '1.1').error).not.toBeNull()
  })
  it('reads rates and their source', () => {
    expect(rateLabel('EUR', 'USD', '1.0765')).toBe('1 EUR = 1.0765 USD')
    expect(rateSourceText('ecb', '2026-10-30', '2026-10-30')).toBe('ECB · Oct 30')
    expect(rateSourceText('ecb', '2026-10-30', '2026-11-01')).toBe('ECB · Oct 30 (latest before Nov 1)')
    expect(rateSourceText('manual', null, '2026-11-01')).toBe('Entered by hand')
  })
  it('accepts only plain positive decimals as a typed rate', () => {
    expect(manualRateOrNull(' 1.08 ')).toBe('1.08')
    for (const bad of ['', '0', '-1', '1e3', '1,5', 'abc', '1.']) expect(manualRateOrNull(bad), bad).toBeNull()
  })
  it('shows original, converted and rate for a converted expense only', () => {
    const eur = { originalMinor: 10000, originalCurrency: 'EUR', settlementMinor: 10765, rate: '1.0765', rateSource: 'ecb', rateDate: '2026-10-30', date: '2026-11-01' }
    expect(conversionLines(eur, 'USD')).toEqual({ original: '€100.00', converted: '$107.65', rate: '1 EUR = 1.0765 USD', source: 'ECB · Oct 30 (latest before Nov 1)' })
    expect(originalText(eur, 'USD')).toBe('€100.00')
    const usd = { originalMinor: 500, originalCurrency: 'USD', settlementMinor: 500, rate: null, date: '2026-11-01' }
    expect(isForeign(usd, 'USD')).toBe(false)
    expect(conversionLines(usd, 'USD')).toBeNull()
    expect(originalText(usd, 'USD')).toBeNull()
    expect(conversionLines({ ...usd, originalCurrency: 'JPY', originalMinor: 1500 }, 'USD')?.original).toContain('1,500')
  })
  it('types the right number of decimals', () => {
    expect([amountPlaceholder('USD'), amountPlaceholder('JPY'), amountPlaceholder('KWD')]).toEqual(['0.00', '0', '0.000'])
  })
  it('history says when the currency or rate changed', () => {
    const lines = historyLines(
      [{ id: 'h', kind: 'edited', actorId: 'me', actorName: 'Me', at: '2026-11-01T10:00:00Z', changes: [{ field: 'currency', from: 'EUR', to: 'JPY' }, { field: 'rate', from: '1.1', to: '1.2' }] }] as never,
      'me', 'USD', (id) => id, () => 'now',
    )
    expect(lines[0]!.text).toBe('You changed the currency to JPY and the exchange rate to 1.2')
  })
})
