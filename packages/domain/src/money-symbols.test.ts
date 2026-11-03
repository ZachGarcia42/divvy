import { describe, expect, it } from 'vitest'
import { FX_CURRENCIES } from './currencies.ts'
import { currencySymbol, formatMoney } from './money.ts'

// DC-18: the narrow symbol printed a bare "$" for every dollar currency.
describe('currency symbols in formatMoney', () => {
  it('USD keeps the bare dollar sign, and every other dollar currency says which dollar', () => {
    expect(formatMoney(1050, 'USD')).toBe('$10.50')
    expect(formatMoney(123456, 'CAD')).toBe('CA$1,234.56')
    expect(formatMoney(123456, 'AUD')).toBe('A$1,234.56')
    expect(formatMoney(123456, 'MXN')).toBe('MX$1,234.56')
    expect(formatMoney(123456, 'NZD')).toBe('NZ$1,234.56')
    expect(formatMoney(123456, 'HKD')).toBe('HK$1,234.56')
    expect(formatMoney(123456, 'SGD')).toBe('S$1,234.56')
    expect(formatMoney(-500, 'cad')).toBe('-CA$5.00')
  })
  it('yen and yuan, and the kroner, are told apart too', () => {
    expect(formatMoney(1500, 'JPY')).toBe('¥1,500')
    expect(formatMoney(150000, 'CNY')).toBe('CN¥1,500.00')
    expect(formatMoney(1200, 'SEK')).toBe('SEK 12.00')
    expect(formatMoney(1200, 'NOK')).toBe('NOK 12.00')
    expect(formatMoney(1200, 'DKK')).toBe('DKK 12.00')
    expect(formatMoney(1200, 'ISK')).toBe('ISK 1,200')
  })
  it('symbols that are already one currency\'s own are unchanged', () => {
    expect(formatMoney(1200, 'EUR')).toBe('€12.00')
    expect(formatMoney(1200, 'GBP')).toBe('£12.00')
    expect(formatMoney(1200, 'BRL')).toBe('R$12.00')
    expect(formatMoney(1200, 'INR')).toBe('₹12.00')
    expect(formatMoney(12345, 'KWD')).toBe('KWD 12.345')
  })
  it('no two offered currencies print the same symbol', () => {
    const seen = new Map<string, string>()
    for (const { code } of FX_CURRENCIES) {
      const symbol = currencySymbol(code)
      expect(seen.get(symbol), `${code} and ${seen.get(symbol)} both read ${symbol}`).toBeUndefined()
      seen.set(symbol, code)
    }
  })
})
