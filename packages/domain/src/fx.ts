import { LedgerError, assertMinor, exponentOf } from './money.ts'

function parseRate(rate: string): { num: bigint; den: bigint } {
  if (!/^\d+(\.\d+)?$/.test(rate) || rate === '0' || /^0\.0+$/.test(rate)) {
    throw new LedgerError('BAD_RATE', 'Exchange rate must be a positive decimal')
  }
  const [whole, frac = ''] = rate.split('.')
  const digits = `${whole}${frac}`.replace(/^0+/, '') || '0'
  return { num: BigInt(digits), den: 10n ** BigInt(frac.length) }
}

function roundDiv(numerator: bigint, denominator: bigint): number {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder * 2n >= denominator) return Number(quotient + 1n)
  return Number(quotient)
}

/** `rate` is target major units per 1 source major unit. */
export function convertMinor(
  sourceMinor: number,
  sourceCurrency: string,
  rate: string,
  targetCurrency: string,
): number {
  assertMinor(sourceMinor, 'Amount')
  if (sourceMinor < 0) throw new LedgerError('BAD_AMOUNT', 'Amount cannot be negative')
  if (sourceCurrency.toUpperCase() === targetCurrency.toUpperCase()) return sourceMinor
  const sourceExp = exponentOf(sourceCurrency)
  const targetExp = exponentOf(targetCurrency)
  const { num, den } = parseRate(rate)
  const numerator = BigInt(sourceMinor) * num * 10n ** BigInt(targetExp)
  const denominator = den * 10n ** BigInt(sourceExp)
  return roundDiv(numerator, denominator)
}

export type MoneyFields = {
  originalMinor: number
  originalCurrency: string
  settlementMinor: number
  overridden: boolean
  date: string
  rate: string | null
}

export function fillFromRate(input: {
  originalMinor: number
  originalCurrency: string
  groupCurrency: string
  rate: string | null
}): { settlementMinor: number; rate: string | null; overridden: false } {
  if (input.originalCurrency.toUpperCase() === input.groupCurrency.toUpperCase()) {
    return { settlementMinor: input.originalMinor, rate: null, overridden: false }
  }
  if (!input.rate) throw new LedgerError('BAD_RATE', 'A rate is required to convert this expense')
  return {
    settlementMinor: convertMinor(input.originalMinor, input.originalCurrency, input.rate, input.groupCurrency),
    rate: input.rate,
    overridden: false,
  }
}

export function nextMoneyFields(input: {
  current: MoneyFields
  patch: Partial<Pick<MoneyFields, 'originalMinor' | 'originalCurrency' | 'settlementMinor' | 'date'>>
  groupCurrency: string
  rateFor: (fromCurrency: string, date: string) => string | null
}): MoneyFields {
  const next: MoneyFields = {
    ...input.current,
    date: input.patch.date ?? input.current.date,
    originalMinor: input.patch.originalMinor ?? input.current.originalMinor,
    originalCurrency: input.patch.originalCurrency ?? input.current.originalCurrency,
  }
  const originalChanged =
    next.originalMinor !== input.current.originalMinor ||
    next.originalCurrency.toUpperCase() !== input.current.originalCurrency.toUpperCase()
  const dateChanged = next.date !== input.current.date
  const settlementProvided = input.patch.settlementMinor !== undefined
  const sameCurrency = next.originalCurrency.toUpperCase() === input.groupCurrency.toUpperCase()

  if (sameCurrency) {
    const minor = settlementProvided && !originalChanged ? input.patch.settlementMinor! : next.originalMinor
    return {
      ...next,
      originalMinor: minor,
      settlementMinor: minor,
      rate: null,
      overridden: false,
    }
  }

  const market = fillFromRate({
    originalMinor: next.originalMinor,
    originalCurrency: next.originalCurrency,
    groupCurrency: input.groupCurrency,
    rate: input.rateFor(next.originalCurrency, next.date),
  })

  if (settlementProvided && input.patch.settlementMinor !== market.settlementMinor) {
    return {
      ...next,
      settlementMinor: input.patch.settlementMinor!,
      rate: market.rate,
      overridden: true,
    }
  }
  if (!settlementProvided && input.current.overridden && !originalChanged) {
    return {
      ...next,
      settlementMinor: input.current.settlementMinor,
      rate: input.current.rate,
      overridden: true,
    }
  }
  return {
    ...next,
    settlementMinor: market.settlementMinor,
    rate: market.rate,
    overridden: false,
  }
}

export function retargetSettlement(input: {
  originalMinor: number
  originalCurrency: string
  settlementMinor: number
  overridden: boolean
  rate: string | null
  fromCurrency: string
  toCurrency: string
  rateOriginalToTarget: string | null
  rateSettlementToTarget: string | null
}): { settlementMinor: number; rate: string | null; overridden: boolean } {
  if (input.fromCurrency.toUpperCase() === input.toCurrency.toUpperCase()) {
    return {
      settlementMinor: input.settlementMinor,
      rate: input.rate,
      overridden: input.overridden,
    }
  }
  if (!input.overridden) {
    const filled = fillFromRate({
      originalMinor: input.originalMinor,
      originalCurrency: input.originalCurrency,
      groupCurrency: input.toCurrency,
      rate:
        input.originalCurrency.toUpperCase() === input.toCurrency.toUpperCase()
          ? null
          : input.rateOriginalToTarget,
    })
    return filled
  }
  if (!input.rateSettlementToTarget && input.fromCurrency.toUpperCase() !== input.toCurrency.toUpperCase()) {
    throw new LedgerError('BAD_RATE', 'A rate is required to convert the agreed amount')
  }
  return {
    settlementMinor: convertMinor(
      input.settlementMinor,
      input.fromCurrency,
      input.rateSettlementToTarget ?? '1',
      input.toCurrency,
    ),
    rate: input.rate,
    overridden: true,
  }
}
