import { LedgerError, assertIsoDate } from './money.ts'

export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'yearly'

function shift(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day! + days))
  return date.toISOString().slice(0, 10)
}

function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const total = year! * 12 + (month! - 1) + months
  const nextYear = Math.floor(total / 12)
  const nextMonthIndex = total % 12
  const lastDay = new Date(Date.UTC(nextYear, nextMonthIndex + 1, 0)).getUTCDate()
  const nextDay = Math.min(day!, lastDay)
  const monthText = String(nextMonthIndex + 1).padStart(2, '0')
  const dayText = String(nextDay).padStart(2, '0')
  return `${nextYear}-${monthText}-${dayText}`
}

export function occurrenceOn(start: string, frequency: Frequency, index: number): string {
  assertIsoDate(start)
  if (!Number.isInteger(index) || index < 0) {
    throw new LedgerError('BAD_DATE', 'Occurrence index must be zero or positive')
  }
  if (frequency === 'weekly') return shift(start, 7 * index)
  if (frequency === 'biweekly') return shift(start, 14 * index)
  if (frequency === 'monthly') return addMonths(start, index)
  if (frequency === 'yearly') return addMonths(start, 12 * index)
  throw new LedgerError('BAD_DATE', 'Unknown frequency')
}

/** The next due date strictly after `today`. Past starts are not backfilled. */
export function nextOccurrence(
  start: string,
  frequency: Frequency,
  today: string,
  end?: string | null,
): string | null {
  assertIsoDate(start)
  assertIsoDate(today)
  if (end) assertIsoDate(end)
  for (let index = 0; index < 5000; index += 1) {
    const date = occurrenceOn(start, frequency, index)
    if (date <= today) continue
    if (end && date > end) return null
    return date
  }
  return null
}
