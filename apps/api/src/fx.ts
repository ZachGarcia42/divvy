import { LedgerError, exponentOf, rateText } from '@divvy/domain'
import type { Sql } from './db.ts'

/** Where exchange rates come from: the ECB reference rates, published by frankfurter (free, no key). */
export const FX_BASE_URL = 'https://api.frankfurter.dev/v1'

export type FxQuote = {
  /** Target-currency units per 1 unit of the source currency, as plain decimal text. */
  rate: string
  /** The date the rate was published for. Weekends and holidays get the latest earlier business day. */
  rateDate: string
}

export type FxService = {
  quote: (from: string, to: string, date: string) => Promise<FxQuote>
}

export class RateUnavailableError extends LedgerError {
  constructor(from: string, to: string) {
    super('RATE_UNAVAILABLE', `Couldn’t get the ${from} to ${to} exchange rate right now. Try again in a moment, or enter the rate yourself.`)
  }
}

export class RateUnsupportedError extends LedgerError {
  constructor(from: string, to: string, date: string) {
    super('RATE_UNSUPPORTED', `There is no published ${from} to ${to} exchange rate for ${date}. Enter the rate yourself.`)
  }
}

const DAY = 86_400_000
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY)

/**
 * A cached rate is final once the day it was quoted for has been published (rateDate == date), or once the date is old enough
 * that a later publication cannot change the answer (ECB publishes ~16:00 CET; a few days is plenty).
 * A weekend/holiday date that fell back to an earlier day is also final after that grace period.
 * Today's (or yesterday's) date that fell back is re-checked after six hours.
 */
export function isFinalRate(requested: string, rateDate: string, fetchedAt: Date, now: Date): boolean {
  if (rateDate === requested) return true
  const age = dayNumber(now.toISOString().slice(0, 10)) - dayNumber(requested)
  if (age >= 5) return true
  return now.getTime() - fetchedAt.getTime() < 6 * 3_600_000
}

export function createFxService(sql: Sql, options?: { now?: () => Date; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): FxService {
  const now = options?.now ?? (() => new Date())
  const doFetch: typeof fetch = (input, init) => (options?.fetch ?? fetch)(input, init)
  const baseUrl = (options?.baseUrl ?? process.env.FX_API_BASE ?? FX_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options?.timeoutMs ?? 4000

  return {
    async quote(fromRaw, toRaw, date) {
      const from = fromRaw.toUpperCase()
      const to = toRaw.toUpperCase()
      exponentOf(from)
      exponentOf(to)
      if (from === to) return { rate: '1', rateDate: date }
      const cached = await sql.query<{ rate: string; source_date: string | null; fetched_at: unknown }>(
        `select rate, source_date, fetched_at from fx_rates where base = $1 and quote = $2 and rate_date = $3`,
        [from, to, date],
      )
      const hit = cached[0]
      if (hit) {
        const fetchedAt = hit.fetched_at instanceof Date ? hit.fetched_at : new Date(String(hit.fetched_at))
        const sourceDate = hit.source_date ?? date
        if (isFinalRate(date, sourceDate, fetchedAt, now())) return { rate: String(hit.rate), rateDate: sourceDate }
      }
      let response: Response
      try {
        response = await doFetch(`${baseUrl}/${date}?base=${from}&symbols=${to}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
      } catch {
        // The source is down or unreachable: a stale-but-known rate beats an error only for the same day's republish window.
        if (hit) return { rate: String(hit.rate), rateDate: hit.source_date ?? date }
        throw new RateUnavailableError(from, to)
      }
      if (response.status === 404 || response.status === 422) throw new RateUnsupportedError(from, to, date)
      if (!response.ok) {
        if (hit) return { rate: String(hit.rate), rateDate: hit.source_date ?? date }
        throw new RateUnavailableError(from, to)
      }
      let body: { date?: unknown; rates?: Record<string, unknown> }
      try {
        body = (await response.json()) as typeof body
      } catch {
        throw new RateUnavailableError(from, to)
      }
      const value = body.rates?.[to]
      if (typeof value !== 'number' || typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new RateUnsupportedError(from, to, date)
      const rate = rateText(value)
      await sql.query(
        `insert into fx_rates (base, quote, rate_date, rate, source_date, fetched_at) values ($1,$2,$3,$4,$5,$6)
         on conflict (base, quote, rate_date) do update set rate = excluded.rate, source_date = excluded.source_date, fetched_at = excluded.fetched_at`,
        [from, to, date, rate, body.date, now().toISOString()],
      )
      return { rate, rateDate: body.date }
    },
  }
}
