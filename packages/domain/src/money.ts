const ZERO_EXPONENT = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])

const THREE_EXPONENT = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'])

export function exponentOf(currency: string): number {
  const code = currency.toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new LedgerError('BAD_CURRENCY', `Unknown currency ${currency}`)
  }
  if (ZERO_EXPONENT.has(code)) return 0
  if (THREE_EXPONENT.has(code)) return 3
  return 2
}

export class LedgerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'LedgerError'
  }
}

export function assertMinor(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new LedgerError('BAD_AMOUNT', `${label} must be an integer number of minor units`)
  }
}

const MAX_MINOR = 2_000_000_000

export function assertAmount(value: number, label: string): void {
  assertMinor(value, label)
  if (value <= 0 || value > MAX_MINOR) {
    throw new LedgerError('BAD_AMOUNT', `${label} must be a positive amount`)
  }
}

export function parseMajor(input: string, currency: string): number {
  const trimmed = input.trim()
  const exp = exponentOf(currency)
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new LedgerError('BAD_AMOUNT', 'Enter a positive amount')
  }
  const [whole, frac = ''] = trimmed.split('.')
  if (frac.length > exp) {
    throw new LedgerError('BAD_AMOUNT', `${currency} uses ${exp} decimal places`)
  }
  const padded = frac.padEnd(exp, '0')
  const minor = Number(whole + padded)
  assertAmount(minor, 'Amount')
  return minor
}

export function formatMoney(minor: number, currency: string): string {
  assertMinor(minor, 'Amount')
  const exp = exponentOf(currency)
  const negative = minor < 0
  const abs = Math.abs(minor)
  const scale = 10 ** exp
  const whole = Math.floor(abs / scale)
  const fraction = exp === 0 ? '' : `.${String(abs % scale).padStart(exp, '0')}`
  const symbol =
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      currencyDisplay: 'narrowSymbol',
    })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value ?? `${currency} `
  return `${negative ? '-' : ''}${symbol}${whole.toLocaleString('en-US')}${fraction}`
}

export function calendarDateInTimeZone(timeZone: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now)
    const year = parts.find((part) => part.type === 'year')?.value
    const month = parts.find((part) => part.type === 'month')?.value
    const day = parts.find((part) => part.type === 'day')?.value
    if (!year || !month || !day) {
      throw new Error('missing')
    }
    return `${year}-${month}-${day}`
  } catch {
    throw new LedgerError('BAD_TIMEZONE', `Unknown timezone ${timeZone}`)
  }
}

export function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new LedgerError('BAD_DATE', 'Date must be YYYY-MM-DD')
  }
  const [year, month, day] = value.split('-').map(Number)
  const check = new Date(Date.UTC(year!, month! - 1, day))
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month! - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new LedgerError('BAD_DATE', 'Date must be YYYY-MM-DD')
  }
}

export function assertNotFuture(date: string, today: string): void {
  assertIsoDate(date)
  assertIsoDate(today)
  if (date > today) {
    throw new LedgerError('FUTURE_DATE', 'An expense cannot be dated in the future')
  }
}
