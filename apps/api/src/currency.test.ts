import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createMemorySql } from './db.ts'
import { groupOf, sessionFor } from './testkit.ts'

describe('USD is the only currency', () => {
  it('creates groups in USD, defaults a missing currency, and rejects anything else', async () => {
    const { call } = await groupOf([])
    for (const currency of ['EUR', 'GBP', 'JPY', '', 'US', 5, null]) {
      const res = await call('POST', '/api/groups', { name: 'Trip', currency, timezone: 'UTC' })
      expect(res.status, String(currency)).toBe(400)
      expect(res.json.error.code, String(currency)).toBe('BAD_CURRENCY')
    }
    const missing = await call('POST', '/api/groups', { name: 'No currency', timezone: 'UTC' })
    expect(missing.status).toBe(200)
    expect(missing.json.group.currency).toBe('USD')
    const lower = await call('POST', '/api/groups', { name: 'Lower', currency: 'usd', timezone: 'UTC' })
    expect(lower.status).toBe(200)
    expect(lower.json.group.currency).toBe('USD')
    // nothing was created by the rejected ones
    const home = await call('GET', '/api/home')
    expect(home.json.groups.map((g: any) => g.name).sort()).toEqual(['Lower', 'No currency', 'Trip'])
  })

  it('rejects a currency change to anything but USD and leaves the group alone', async () => {
    const { call, groupId } = await groupOf([])
    const bad = await call('PATCH', `/api/groups/${groupId}`, { currency: 'EUR' })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('BAD_CURRENCY')
    expect((await call('GET', `/api/groups/${groupId}`)).json.group.currency).toBe('USD')
    expect((await call('PATCH', `/api/groups/${groupId}`, { currency: 'USD' })).status).toBe(200)
    expect((await call('PATCH', `/api/groups/${groupId}`, { name: 'Renamed' })).status).toBe(200)
  })

  it('rejects an expense in another currency, on create and on edit, and accepts a missing one', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const body = (extra: object) => ({ description: 'Lunch', date: '2026-10-20', originalMinor: 1000, payers: [{ participantId: you, minor: 1000 }], split: { type: 'equal', participantIds: [you, maya] }, ...extra })
    const eur = await call('POST', `/api/groups/${groupId}/expenses`, body({ originalCurrency: 'EUR' }))
    expect(eur.status).toBe(400)
    expect(eur.json.error.code).toBe('BAD_CURRENCY')
    const none = await call('POST', `/api/groups/${groupId}/expenses`, body({}))
    expect(none.status).toBe(200)
    const usd = await call('POST', `/api/groups/${groupId}/expenses`, body({ originalCurrency: 'USD' }))
    expect(usd.status).toBe(200)
    const edit = await call('PATCH', `/api/groups/${groupId}/expenses/${usd.json.id}`, { version: 1, originalCurrency: 'GBP' })
    expect(edit.status).toBe(400)
    expect(edit.json.error.code).toBe('BAD_CURRENCY')
    expect((await call('GET', `/api/groups/${groupId}`)).json.expenses).toHaveLength(2)
  })

  it('leaves an existing non-USD group readable', async () => {
    const sql = await createMemorySql()
    const { app, repo } = createApp(sql, { now: () => new Date('2026-10-27T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const token = await sessionFor(app, 'alex@example.com')
    const actor = (await repo.actorFromToken(token))!
    const legacy = await repo.createGroup(actor, { name: 'Lisbon', currency: 'EUR', timezone: 'Europe/Lisbon' })
    const headers = { authorization: `Bearer ${token}`, 'x-divvy-platform': 'ios' }
    const detail = await app.request(`/api/groups/${legacy.group.id}`, { headers })
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as any).group.currency).toBe('EUR')
    const home = await (await app.request('/api/home', { headers })).json() as any
    expect(home.groups.find((g: any) => g.name === 'Lisbon').currency).toBe('EUR')
  })
})
