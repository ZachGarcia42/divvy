// Multiple currencies, the client side: what the Add-expense sheet shows while an amount in another currency is converted, and how
// an expense that was entered in another currency reads in the list and the detail. Pure, so it is unit-tested; the server is the authority.
import { assertRate, convertMinor, exponentOf, formatMoney, LedgerError, parseMajor } from '@divvy/domain'
import { monthDay } from './view'

export type Quote = { rate: string; rateDate: string; source: 'ecb' | 'manual' }

/** A rate as a person reads it: "1 EUR = 1.0765 USD". */
export function rateLabel(from: string, to: string, rate: string): string {
  return `1 ${from} = ${rate} ${to}`
}

/** Where a rate came from: "ECB · Oct 30", or "ECB · Oct 30 (latest before Nov 1)" when the day itself had none (weekend, holiday, not yet published). */
export function rateSourceText(source: string | null | undefined, rateDate: string | null | undefined, expenseDate: string): string {
  if (source === 'manual') return 'Entered by hand'
  if (!rateDate) return 'ECB'
  return rateDate === expenseDate ? `ECB · ${monthDay(rateDate)}` : `ECB · ${monthDay(rateDate)} (latest before ${monthDay(expenseDate)})`
}

/** A typed rate, or null while it is not a usable positive decimal yet. */
export function manualRateOrNull(text: string): string | null {
  try { return assertRate(text) } catch { return null }
}

export type SheetMoney = {
  /** What was typed, in the expense's own currency (no $100,000 limit: that applies to the converted amount). */
  original: number | null
  /** The same amount in the group currency; null while the amount or the rate is missing. */
  converted: number | null
  /** Why the typed amount can't be used (wrong decimals, zero…), or null. */
  error: string | null
}

export function sheetMoney(amountText: string, expenseCurrency: string, groupCurrency: string, rate: string | null): SheetMoney {
  const same = expenseCurrency === groupCurrency
  if (!amountText.trim()) return { original: null, converted: null, error: null }
  let original: number
  try { original = parseMajor(amountText, expenseCurrency, { cap: same }) } catch (reason) {
    if (reason instanceof LedgerError && reason.code === 'TOO_LARGE') return { original: null, converted: null, error: null }
    return { original: null, converted: null, error: reason instanceof Error ? reason.message : 'Not an amount' }
  }
  if (same) return { original, converted: original, error: null }
  if (!rate) return { original, converted: null, error: null }
  return { original, converted: convertMinor(original, expenseCurrency, rate, groupCurrency), error: null }
}

type Row = { originalMinor?: number; originalCurrency?: string; settlementMinor: number; rate?: string | null; rateSource?: string | null; rateDate?: string | null; date: string }

/** True when the expense was entered in a currency other than the group's. */
export function isForeign(expense: Row, groupCurrency: string): boolean {
  return !!expense.originalCurrency && expense.originalCurrency !== groupCurrency && expense.originalMinor !== undefined
}

/** The original amount, for the list row: "€100.00". Null for an expense in the group currency. */
export function originalText(expense: Row, groupCurrency: string): string | null {
  return isForeign(expense, groupCurrency) ? formatMoney(expense.originalMinor!, expense.originalCurrency!) : null
}

/** The group-list row's line under the amount: "of €42.00" (the whole expense, since the amount above is your share). Null for an expense in the group currency. */
export function rowOriginalText(expense: Row, groupCurrency: string): string | null {
  const original = originalText(expense, groupCurrency)
  return original ? `of ${original}` : null
}

/** The three lines the expense detail shows for a converted expense; null for an expense in the group currency. */
export function conversionLines(expense: Row, groupCurrency: string): { original: string; converted: string; rate: string; source: string } | null {
  if (!isForeign(expense, groupCurrency)) return null
  const from = expense.originalCurrency!
  const rate = expense.rate ?? ''
  return {
    original: formatMoney(expense.originalMinor!, from),
    converted: formatMoney(expense.settlementMinor, groupCurrency),
    rate: rate ? rateLabel(from, groupCurrency, rate) : 'Rate not recorded',
    source: rateSourceText(expense.rateSource ?? (rate ? 'ecb' : null), expense.rateDate ?? null, expense.date),
  }
}

/** What the sheet types for an amount in `currency`: 0 decimals for yen, 3 for dinar. */
export function amountPlaceholder(currency: string): string {
  const exp = exponentOf(currency)
  return exp === 0 ? '0' : `0.${'0'.repeat(exp)}`
}

export const RATE_DOWN_MESSAGE = 'Couldn’t get the exchange rate right now. Try again, or enter the rate yourself.'
