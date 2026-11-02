import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createMemorySql } from './db.ts'
import { groupOf, sessionFor } from './testkit.ts'

/** A fixed table of ECB-style rates by date, standing in for the exchange-rate source. */
const RATES: Record<string, Record<string, string>> = {
  'EUR:USD': { '2026-10-20': '1.1000', '2026-10-21': '1.2000', '2026-10-22': '1.0000' },
  'JPY:USD': { '2026-10-20': '0.0066', '2026-10-21': '0.0070', '2026-10-22': '0.0070' },
  'USD:KWD': { '2026-10-20': '0.3070', '2026-10-21': '0.3070', '2026-10-22': '0.3070' },
  'USD:JPY': { '2026-10-20': '150', '2026-10-21': '150', '2026-10-22': '150' },
  'KWD:USD': { '2026-10-20': '3.2573' },
  'EUR:JPY': { '2026-10-20': '162.5' },
}
const calls: string[] = []
const table = async (from: string, to: string, date: string) => {
  calls.push(`${from}:${to}:${date}`)
  const rate = RATES[`${from}:${to}`]?.[date]
  if (!rate) throw new Error(`no rate in test table: ${from}:${to}:${date}`)
  return rate
}

const expenseBody = (you: string, maya: string, extra: object) => ({
  description: 'Lunch',
  date: '2026-10-20',
  originalMinor: 1000,
  payers: [{ participantId: you, minor: 1000 }],
  split: { type: 'equal', participantIds: [you, maya] },
  ...extra,
})

describe('groups pick their own currency', () => {
  it('defaults to USD, accepts any ISO code, and rejects things that are not codes', async () => {
    const { call } = await groupOf([])
    for (const currency of ['', 'US', 'EURO', '12$', 5, null]) {
      const res = await call('POST', '/api/groups', { name: 'Trip', currency, timezone: 'UTC' })
      expect(res.status, String(currency)).toBe(400)
    }
    expect((await call('POST', '/api/groups', { name: 'No currency', timezone: 'UTC' })).json.group.currency).toBe('USD')
    expect((await call('POST', '/api/groups', { name: 'Lower', currency: 'eur', timezone: 'UTC' })).json.group.currency).toBe('EUR')
    expect((await call('POST', '/api/groups', { name: 'Yen', currency: 'JPY', timezone: 'UTC' })).json.group.currency).toBe('JPY')
  })

  it('only changes currency while the group is empty', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    expect((await call('PATCH', `/api/groups/${groupId}`, { currency: 'EUR' })).json.group.currency).toBe('EUR')
    expect((await call('PATCH', `/api/groups/${groupId}`, { currency: 'USD' })).json.group.currency).toBe('USD')
    expect((await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, {}))).status).toBe(200)
    const locked = await call('PATCH', `/api/groups/${groupId}`, { currency: 'EUR' })
    expect(locked.status).toBe(400)
    expect(locked.json.error.code).toBe('CURRENCY_LOCKED')
    expect((await call('GET', `/api/groups/${groupId}`)).json.group.currency).toBe('USD')
  })

  it('leaves an existing non-USD group readable', async () => {
    const sql = await createMemorySql()
    const { app, repo } = createApp(sql, { now: () => new Date('2026-10-27T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const token = await sessionFor(app, 'alex@example.com')
    const actor = (await repo.actorFromToken(token))!
    const legacy = await repo.createGroup(actor, { name: 'Lisbon', currency: 'EUR', timezone: 'Europe/Lisbon' })
    const headers = { authorization: `Bearer ${token}`, 'x-divvy-platform': 'ios' }
    expect(((await (await app.request(`/api/groups/${legacy.group.id}`, { headers })).json()) as any).group.currency).toBe('EUR')
  })
})

describe('expenses in another currency', () => {
  it('converts at the rate for the expense date and stores amount, rate and source on the expense', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: table })
    const [you, maya] = ids as [string, string]
    // 10.00 EUR on the 20th at 1.10 = 11.00 USD
    const a = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR', date: '2026-10-20', payers: [{ participantId: you, minor: 1100 }] }))
    expect(a.status).toBe(200)
    // The same 10.00 EUR on the 21st at 1.20 = 12.00 USD: each expense uses its own day's rate
    const b = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR', date: '2026-10-21', payers: [{ participantId: you, minor: 1200 }] }))
    expect(b.status).toBe(200)
    const detail = (await call('GET', `/api/groups/${groupId}`)).json
    const byDate = Object.fromEntries(detail.expenses.map((e: any) => [e.date, e]))
    expect(byDate['2026-10-20']).toMatchObject({ originalMinor: 1000, originalCurrency: 'EUR', settlementMinor: 1100, currency: 'USD', rate: '1.1000', rateSource: 'ecb', rateDate: '2026-10-20' })
    expect(byDate['2026-10-21']).toMatchObject({ originalMinor: 1000, settlementMinor: 1200, rate: '1.2000' })
    // Balances, and the breakdown, are in the group currency: 11.00 + 12.00 paid by you, split equally with Maya
    expect(detail.currency).toBe('USD')
    const mayaNet = detail.nets.find((m: any) => m.participantId === maya).netMinor
    expect(mayaNet).toBe(-(1100 + 1200) / 2)
    expect(detail.payments[0]).toMatchObject({ fromId: maya, toId: you, minor: 1150 })
    const stats = await call('GET', `/api/groups/${groupId}/charts?from=2026-10-01&to=2026-10-31`)
    expect(stats.json.currency).toBe('USD')
    expect(JSON.stringify(stats.json)).toContain('2300')
  })

  it('a same-currency expense stays at rate 1 and never asks for a rate', async () => {
    calls.length = 0
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: table })
    const [you, maya] = ids as [string, string]
    const res = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'USD' }))
    expect(res.status).toBe(200)
    const expense = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0]
    expect(expense).toMatchObject({ originalCurrency: 'USD', settlementMinor: 1000, rate: null, rateSource: null })
    expect(calls).toEqual([])
  })

  it('the stored rate never changes afterwards, even when the amount is edited', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: table })
    const [you, maya] = ids as [string, string]
    const made = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR', date: '2026-10-20' }))
    const version = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0].version
    // The source's rate for that day is revised after the fact; an edit that keeps date and currency keeps the stored rate.
    RATES['EUR:USD']!['2026-10-20'] = '1.5000'
    try {
      const edit = await call('PATCH', `/api/groups/${groupId}/expenses/${made.json.id}`, { version, originalMinor: 2000, originalCurrency: 'EUR', date: '2026-10-20' })
      expect(edit.status).toBe(200)
      const expense = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0]
      expect(expense).toMatchObject({ originalMinor: 2000, settlementMinor: 2200, rate: '1.1000' })
    } finally {
      RATES['EUR:USD']!['2026-10-20'] = '1.1000'
    }
  })

  it('editing the date or the currency fetches a new rate', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: table })
    const [you, maya] = ids as [string, string]
    const made = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR', date: '2026-10-20' }))
    let expense = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0]
    expect(expense.settlementMinor).toBe(1100)
    const moved = await call('PATCH', `/api/groups/${groupId}/expenses/${made.json.id}`, { version: expense.version, date: '2026-10-21' })
    expect(moved.status).toBe(200)
    expense = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0]
    expect(expense).toMatchObject({ date: '2026-10-21', settlementMinor: 1200, rate: '1.2000', rateDate: '2026-10-21' })
    // 1000 JPY on the 21st at 0.0070 = 7.00 USD
    const swapped = await call('PATCH', `/api/groups/${groupId}/expenses/${made.json.id}`, { version: expense.version, originalCurrency: 'JPY' })
    expect(swapped.status).toBe(200)
    expense = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0]
    expect(expense).toMatchObject({ originalCurrency: 'JPY', originalMinor: 1000, settlementMinor: 700, rate: '0.0070' })
    // ...and back to the group currency: rate gone, amount is the typed amount
    const home = await call('PATCH', `/api/groups/${groupId}/expenses/${made.json.id}`, { version: expense.version, originalCurrency: 'USD' })
    expect(home.status).toBe(200)
    expense = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0]
    expect(expense).toMatchObject({ originalCurrency: 'USD', settlementMinor: 1000, rate: null })
    // the history says what changed
    const history = (await call('GET', `/api/groups/${groupId}/expenses/${made.json.id}`)).json.history
    expect(history.map((h: any) => h.kind)).toEqual(['created', 'edited', 'edited', 'edited'])
    const fields = (i: number) => history[i].changes.map((c: any) => c.field)
    expect(fields(1)).toContain('date')
    expect(fields(1)).toContain('amount')
    expect(history[1].changes.find((c: any) => c.field === 'rate')).toMatchObject({ from: '1.1000', to: '1.2000' })
    expect(history[2].changes.find((c: any) => c.field === 'currency')).toMatchObject({ from: 'EUR', to: 'JPY' })
    expect(fields(2)).not.toContain('rate')
  })

  it('takes a manual rate, keeps it on later edits, and marks the source', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: async () => { throw new Error('should not be asked') } })
    const [you, maya] = ids as [string, string]
    const made = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR', rate: '1.0850' }))
    expect(made.status).toBe(200)
    let expense = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0]
    expect(expense).toMatchObject({ settlementMinor: 1085, rate: '1.0850', rateSource: 'manual' })
    const edit = await call('PATCH', `/api/groups/${groupId}/expenses/${made.json.id}`, { version: expense.version, originalMinor: 2000 })
    expect(edit.status).toBe(200)
    expense = (await call('GET', `/api/groups/${groupId}`)).json.expenses[0]
    expect(expense).toMatchObject({ settlementMinor: 2170, rate: '1.0850', rateSource: 'manual' })
    for (const bad of ['0', '-1', 'abc', '1e-7', '1.2.3', '0.0000000000001']) {
      const res = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR', rate: bad }))
      expect(res.status, bad).toBe(400)
      expect(res.json.error.code, bad).toBe('BAD_RATE')
    }
  })

  it('handles currencies with 0 and 3 decimal places in either direction', async () => {
    const yen = await groupOf(['Maya'], undefined, { currency: 'JPY', rateFor: table })
    const [you, maya] = yen.ids as [string, string]
    // 10.00 USD in a yen group at 150 = 1500 yen (yen have no minor unit)
    const made = await yen.call('POST', `/api/groups/${yen.groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'USD', originalMinor: 1000, payers: [{ participantId: you, minor: 1500 }] }))
    expect(made.status).toBe(200)
    expect((await yen.call('GET', `/api/groups/${yen.groupId}`)).json.expenses[0]).toMatchObject({ originalMinor: 1000, settlementMinor: 1500, currency: 'JPY' })

    const dinar = await groupOf(['Maya'], undefined, { currency: 'KWD', rateFor: table })
    const [you2, maya2] = dinar.ids as [string, string]
    // 100.00 USD at 0.307 = 30.700 KWD = 30700 fils
    const kwd = await dinar.call('POST', `/api/groups/${dinar.groupId}/expenses`, expenseBody(you2, maya2, { originalCurrency: 'USD', originalMinor: 10000, payers: [{ participantId: you2, minor: 30700 }] }))
    expect(kwd.status).toBe(200)
    expect((await dinar.call('GET', `/api/groups/${dinar.groupId}`)).json.expenses[0]).toMatchObject({ settlementMinor: 30700, currency: 'KWD' })

    const usd = await groupOf(['Maya'], undefined, { rateFor: table })
    const [you3, maya3] = usd.ids as [string, string]
    // 1000 fils is 1.000 KWD: at 3.2573 that is 3.26 USD (rounded half up to cents)
    const back = await usd.call('POST', `/api/groups/${usd.groupId}/expenses`, expenseBody(you3, maya3, { originalCurrency: 'KWD', originalMinor: 1000, payers: [{ participantId: you3, minor: 326 }] }))
    expect(back.status).toBe(200)
    expect((await usd.call('GET', `/api/groups/${usd.groupId}`)).json.expenses[0]).toMatchObject({ originalMinor: 1000, settlementMinor: 326 })
  })

  it('applies the $100,000 limit to the converted amount', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: async () => '1.1000' })
    const [you, maya] = ids as [string, string]
    const send = (originalMinor: number, originalCurrency: string) => call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalMinor, originalCurrency, payers: [{ participantId: you, minor: 1 }] }))
    // 95,000.00 EUR is 104,500.00 USD: over the limit even though the typed number is under it
    const over = await send(9_500_000, 'EUR')
    expect(over.status).toBe(400)
    expect(over.json.error.code).toBe('TOO_LARGE')
    // 90,909.09 EUR converts to 100,000.00 USD: at the limit, accepted
    expect((await send(9_090_909, 'EUR')).status).toBe(200)
    // 150,000 yen is about $1,050: the typed amount is over 100,000 but the converted one is not
    const yen = await groupOf(['Maya'], undefined, { rateFor: async () => '0.0070' })
    const [y1, y2] = yen.ids as [string, string]
    const ok = await yen.call('POST', `/api/groups/${yen.groupId}/expenses`, expenseBody(y1, y2, { originalMinor: 150_000, originalCurrency: 'JPY', payers: [{ participantId: y1, minor: 1 }] }))
    expect(ok.status).toBe(200)
  })

  it('a rate outage is a clear 503 and saves nothing; a manual rate still works', async () => {
    const down = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { fxFetch: down })
    const [you, maya] = ids as [string, string]
    const res = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR' }))
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('RATE_UNAVAILABLE')
    expect(res.json.error.message).toMatch(/enter the rate yourself/i)
    expect((await call('GET', `/api/groups/${groupId}`)).json.expenses).toHaveLength(0)
    const quote = await call('GET', `/api/groups/${groupId}/fx?from=EUR&date=2026-10-20`)
    expect(quote.status).toBe(503)
    const manual = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR', rate: '1.1' }))
    expect(manual.status).toBe(200)
  })

  it('GET /fx previews the rate the save would use', async () => {
    const { call, groupId } = await groupOf(['Maya'], undefined, { rateFor: table })
    const quote = await call('GET', `/api/groups/${groupId}/fx?from=eur&date=2026-10-21`)
    expect(quote.status).toBe(200)
    expect(quote.json).toMatchObject({ from: 'EUR', to: 'USD', rate: '1.2000', rateDate: '2026-10-21', source: 'ecb' })
    expect((await call('GET', `/api/groups/${groupId}/fx?from=USD&date=2026-10-21`)).json).toMatchObject({ rate: '1', source: null })
    expect((await call('GET', `/api/groups/${groupId}/fx?from=EU&date=2026-10-21`)).status).toBe(400)
    expect((await call('GET', `/api/groups/${groupId}/fx?from=EUR&date=2026-13-45`)).status).toBe(400)
    expect((await call('GET', `/api/groups/${groupId}/fx?from=EUR&date=2027-01-01`)).status).toBe(400)
  })

  it('rejects an unknown currency code on an expense', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: table })
    const [you, maya] = ids as [string, string]
    for (const originalCurrency of ['EU', 'EURO', '12$']) {
      const res = await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency }))
      expect(res.status, originalCurrency).toBe(400)
      expect(res.json.error.code, originalCurrency).toBe('BAD_CURRENCY')
    }
  })

  it('settle-up works in the group currency across mixed-currency expenses', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: table })
    const [you, maya] = ids as [string, string]
    await call('POST', `/api/groups/${groupId}/expenses`, expenseBody(you, maya, { originalCurrency: 'EUR', originalMinor: 2000, date: '2026-10-21', payers: [{ participantId: you, minor: 1 }] }))
    const detail = (await call('GET', `/api/groups/${groupId}`)).json
    expect(detail.payments[0]).toMatchObject({ fromId: maya, toId: you, minor: 1200 })
    const pay = await call('POST', `/api/groups/${groupId}/settlements`, { fromId: maya, toId: you, minor: 1200, date: '2026-10-22' })
    expect(pay.status).toBe(200)
    expect((await call('GET', `/api/groups/${groupId}`)).json.payments).toEqual([])
  })
})
