import { describe, expect, it } from 'vitest'
import { createMemorySql } from './db.ts'
import { createFxService, isFinalRate } from './fx.ts'

type Hit = { url: string }
/** A stand-in for the rate source: answers per requested date, falling back like the ECB does on weekends. */
function source(answers: Record<string, { date: string; rate: number } | number | 'down'>, hits: Hit[] = []) {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    hits.push({ url })
    const day = url.split('/v1/')[1]!.split('?')[0]!
    const answer = answers[day]
    if (answer === 'down') return new Response('oops', { status: 502 })
    if (typeof answer === 'number') return new Response('{}', { status: answer })
    if (!answer) return new Response('{"message":"not found"}', { status: 404 })
    return new Response(JSON.stringify({ amount: 1, base: 'EUR', date: answer.date, rates: { USD: answer.rate } }), { status: 200 })
  }) as unknown as typeof fetch
}

describe('exchange-rate service', () => {
  it('fetches a business-day rate and caches it by date and pair', async () => {
    const sql = await createMemorySql()
    const hits: Hit[] = []
    const fx = createFxService(sql, { fetch: source({ '2026-10-20': { date: '2026-10-20', rate: 1.1634 } }, hits), now: () => new Date('2026-10-27T12:00:00Z') })
    expect(await fx.quote('EUR', 'USD', '2026-10-20')).toEqual({ rate: '1.1634', rateDate: '2026-10-20' })
    expect(await fx.quote('eur', 'usd', '2026-10-20')).toEqual({ rate: '1.1634', rateDate: '2026-10-20' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.url).toContain('/v1/2026-10-20?base=EUR&symbols=USD')
    // another pair or date is a separate entry
    await expect(fx.quote('USD', 'EUR', '2026-10-20')).rejects.toMatchObject({ code: 'RATE_UNSUPPORTED' })
  })

  it('a weekend uses the latest earlier rate, and an old weekend date is cached for good', async () => {
    const sql = await createMemorySql()
    const hits: Hit[] = []
    // 2026-10-24 is a Saturday: the source answers with Friday's rate
    const fx = createFxService(sql, { fetch: source({ '2026-10-24': { date: '2026-10-23', rate: 1.0912 } }, hits), now: () => new Date('2026-11-02T12:00:00Z') })
    expect(await fx.quote('EUR', 'USD', '2026-10-24')).toEqual({ rate: '1.0912', rateDate: '2026-10-23' })
    await fx.quote('EUR', 'USD', '2026-10-24')
    expect(hits).toHaveLength(1)
  })

  it('re-checks a recent weekend/holiday date after six hours, in case the day was published late', async () => {
    const sql = await createMemorySql()
    const hits: Hit[] = []
    let now = new Date('2026-10-26T08:00:00Z')
    const answers: Record<string, { date: string; rate: number }> = { '2026-10-26': { date: '2026-10-23', rate: 1.09 } }
    const fx = createFxService(sql, { fetch: source(answers, hits), now: () => now })
    expect((await fx.quote('EUR', 'USD', '2026-10-26')).rateDate).toBe('2026-10-23')
    now = new Date('2026-10-26T10:00:00Z')
    await fx.quote('EUR', 'USD', '2026-10-26')
    expect(hits).toHaveLength(1)
    answers['2026-10-26'] = { date: '2026-10-26', rate: 1.1 }
    now = new Date('2026-10-26T20:00:00Z')
    expect(await fx.quote('EUR', 'USD', '2026-10-26')).toEqual({ rate: '1.1', rateDate: '2026-10-26' })
    expect(hits).toHaveLength(2)
  })

  it('says so clearly when the source is down, and uses what it already has if it has it', async () => {
    const sql = await createMemorySql()
    const fx = createFxService(sql, { fetch: source({ '2026-10-20': 'down' }), now: () => new Date('2026-10-27T12:00:00Z') })
    await expect(fx.quote('EUR', 'USD', '2026-10-20')).rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' })
    const thrown = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const offline = createFxService(sql, { fetch: thrown })
    await expect(offline.quote('EUR', 'USD', '2026-10-20')).rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' })
    const junk = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    await expect(createFxService(sql, { fetch: junk }).quote('EUR', 'USD', '2026-10-20')).rejects.toMatchObject({ code: 'RATE_UNAVAILABLE' })
    // a recent fallback entry that is due a re-check still serves while the source is down
    const sql2 = await createMemorySql()
    let now = new Date('2026-10-26T08:00:00Z')
    const answers: Record<string, any> = { '2026-10-26': { date: '2026-10-23', rate: 1.09 } }
    const flaky = createFxService(sql2, { fetch: source(answers), now: () => now })
    await flaky.quote('EUR', 'USD', '2026-10-26')
    answers['2026-10-26'] = 'down'
    now = new Date('2026-10-26T20:00:00Z')
    expect(await flaky.quote('EUR', 'USD', '2026-10-26')).toEqual({ rate: '1.09', rateDate: '2026-10-23' })
  })

  it('a pair the source does not publish is RATE_UNSUPPORTED (enter the rate yourself)', async () => {
    const sql = await createMemorySql()
    const fx = createFxService(sql, { fetch: source({}) })
    await expect(fx.quote('EUR', 'USD', '2026-10-20')).rejects.toMatchObject({ code: 'RATE_UNSUPPORTED' })
    await expect(fx.quote('EU', 'USD', '2026-10-20')).rejects.toMatchObject({ code: 'BAD_CURRENCY' })
  })

  it('writes tiny and large rates as plain decimals', async () => {
    const sql = await createMemorySql()
    const body = (rate: number) => (async () => new Response(JSON.stringify({ date: '2026-10-20', rates: { USD: rate } }), { status: 200 })) as unknown as typeof fetch
    expect(await createFxService(sql, { fetch: body(0.0000012) }).quote('IDR', 'USD', '2026-10-20')).toEqual({ rate: '0.0000012', rateDate: '2026-10-20' })
    expect(await createFxService(sql, { fetch: body(0.00006434) }).quote('KRW', 'USD', '2026-10-20')).toEqual({ rate: '0.00006434', rateDate: '2026-10-20' })
    expect((await createFxService(sql, { fetch: body(1465.123) }).quote('KWD', 'USD', '2026-10-20')).rate).toBe('1465.123')
  })

  it('same currency is 1 with no lookup', async () => {
    const sql = await createMemorySql()
    const fx = createFxService(sql, { fetch: source({}) })
    expect(await fx.quote('USD', 'USD', '2026-10-20')).toEqual({ rate: '1', rateDate: '2026-10-20' })
  })

  it('isFinalRate', () => {
    const now = new Date('2026-10-27T12:00:00Z')
    expect(isFinalRate('2026-10-27', '2026-10-27', new Date('2026-10-27T01:00:00Z'), now)).toBe(true)
    expect(isFinalRate('2026-10-26', '2026-10-23', new Date('2026-10-26T01:00:00Z'), now)).toBe(false)
    expect(isFinalRate('2026-10-26', '2026-10-23', new Date('2026-10-27T10:00:00Z'), now)).toBe(true)
    expect(isFinalRate('2026-10-20', '2026-10-16', new Date('2026-10-20T01:00:00Z'), now)).toBe(true)
  })
})
