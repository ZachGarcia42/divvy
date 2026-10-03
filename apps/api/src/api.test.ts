import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createMemorySql } from './db.ts'

async function sessionFor(app: ReturnType<typeof createApp>['app'], email: string) {
  const started = await app.request('/api/auth/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const issued = await started.json() as { devToken: string }
  const verified = await app.request('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: issued.devToken }),
  })
  const body = await verified.json() as { token: string; user: { displayName: string } }
  return { token: body.token, user: body.user }
}

describe('ledger API', () => {
  it('derives balances, simplifies across a third person, and refuses a stale save', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, {
      now: () => new Date('2026-09-26T15:00:00Z'),
      rateFor: async () => '1.08',
      dev: true,
    })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'America/New_York' }),
    })
    const group = await created.json() as { group: { id: string }; members: { id: string; name: string }[] }
    expect(created.status).toBe(200)
    const bob = await app.request(`/api/groups/${group.group.id}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Bob' }),
    })
    const charlie = await app.request(`/api/groups/${group.group.id}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Charlie' }),
    })
    const bobId = ((await bob.json()) as { participantId: string }).participantId
    const charlieId = ((await charlie.json()) as { participantId: string }).participantId
    const alexId = group.members[0]!.id

    const first = await app.request(`/api/groups/${group.group.id}/expenses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description: 'Anna owes Bob',
        date: '2026-09-01',
        originalMinor: 2000,
        originalCurrency: 'USD',
        payers: [{ participantId: bobId, minor: 2000 }],
        split: { type: 'exact', amounts: [{ participantId: alexId, minor: 2000 }, { participantId: bobId, minor: 0 }] },
      }),
    })
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { id: string }
    await app.request(`/api/groups/${group.group.id}/expenses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description: 'Bob owes Charlie',
        date: '2026-09-02',
        originalMinor: 2000,
        originalCurrency: 'USD',
        payers: [{ participantId: charlieId, minor: 2000 }],
        split: { type: 'exact', amounts: [{ participantId: bobId, minor: 2000 }, { participantId: charlieId, minor: 0 }] },
      }),
    })
    const detail = await (await app.request(`/api/groups/${group.group.id}`, { headers: auth })).json() as {
      payments: { fromId: string; toId: string; minor: number }[]
      nets: { participantId: string; netMinor: number }[]
    }
    expect(detail.payments).toEqual([{ fromId: alexId, toId: charlieId, minor: 2000 }])
    expect(detail.nets.find((row) => row.participantId === bobId)?.netMinor).toBe(0)

    const stale = await app.request(`/api/groups/${group.group.id}/expenses/${firstBody.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ version: 0, description: 'Nope' }),
    })
    expect(stale.status).toBe(409)

    const removed = await app.request(`/api/groups/${group.group.id}/members/${bobId}/remove`, { method: 'POST', headers: auth })
    expect(removed.status).toBe(200)
    const owed = await app.request(`/api/groups/${group.group.id}/members/${alexId}/remove`, { method: 'POST', headers: auth })
    expect(owed.status).toBe(400)
  })

  it('does not add an existing account until they accept', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { now: () => new Date('2026-09-26T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    await sessionFor(app, 'jordan@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Trip', currency: 'USD', timezone: 'UTC' }),
    })).json() as { group: { id: string }; members: { id: string }[] }
    const added = await app.request(`/api/groups/${created.group.id}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ email: 'jordan@example.com', displayName: 'Jordan' }),
    })
    expect(await added.json()).toMatchObject({ status: 'invited' })
    const detail = await (await app.request(`/api/groups/${created.group.id}`, { headers: auth })).json() as { members: { name: string }[] }
    expect(detail.members.map((member) => member.name)).toEqual(['Alex'])
  })

  it('keeps a locked conversion, applies a percent split, and does not backfill rent', async () => {
    const sql = await createMemorySql()
    const early = createApp(sql, {
      now: () => new Date('2026-09-26T16:00:00Z'),
      rateFor: async () => '1.08',
      dev: true,
    })
    const alex = await sessionFor(early.app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await early.app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Trip', currency: 'USD', timezone: 'UTC' }),
    })).json() as { group: { id: string }; members: { id: string }[] }
    const groupId = created.group.id
    const alexId = created.members[0]!.id
    const bobId = ((await (await early.app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Bob' }),
    })).json()) as { participantId: string }).participantId

    await early.app.request(`/api/groups/${groupId}/defaults`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ weights: [
        { participantId: alexId, weight: 60 },
        { participantId: bobId, weight: 40 },
      ] }),
    })
    const hotel = await early.app.request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description: 'Hotel',
        date: '2026-09-01',
        originalMinor: 20000,
        originalCurrency: 'EUR',
        payers: [{ participantId: alexId, minor: 1 }],
        split: { type: 'percent', parts: [
          { participantId: alexId, bps: 6000 },
          { participantId: bobId, bps: 4000 },
        ] },
      }),
    })
    expect(hotel.status).toBe(200)
    const detail = await (await early.app.request(`/api/groups/${groupId}`, { headers: auth })).json() as {
      expenses: { description: string; settlementMinor: number; shares: { participantId: string; minor: number }[] }[]
      members: { id: string; defaultWeight: number | null }[]
    }
    const saved = detail.expenses.find((expense) => expense.description === 'Hotel')
    expect(saved?.settlementMinor).toBe(21600)
    expect(saved?.shares).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: alexId, minor: 12960 }),
      expect.objectContaining({ participantId: bobId, minor: 8640 }),
    ]))
    expect(saved?.shares).toHaveLength(2)
    expect(detail.members.map((member) => member.defaultWeight).sort()).toEqual([40, 60])

    const recurrence = await (await early.app.request(`/api/groups/${groupId}/recurrences`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description: 'Rent',
        frequency: 'monthly',
        startDate: '2026-01-01',
        settlementMinor: 100000,
        payers: [{ participantId: alexId, minor: 100000 }],
        shares: [
          { participantId: alexId, minor: 60000 },
          { participantId: bobId, minor: 40000 },
        ],
      }),
    })).json() as { nextDate: string }
    expect(recurrence.nextDate).toBe('2026-10-01')
    const beforeTick = await (await early.app.request(`/api/groups/${groupId}`, { headers: auth })).json() as { expenses: { description: string }[] }
    expect(beforeTick.expenses.filter((expense) => expense.description === 'Rent')).toHaveLength(0)

    const later = createApp(sql, {
      now: () => new Date('2026-10-01T16:00:00Z'),
      rateFor: async () => '1.08',
      dev: true,
    })
    await later.repo.tickRecurrences()
    const afterTick = await (await later.app.request(`/api/groups/${groupId}`, { headers: auth })).json() as {
      expenses: { description: string; date: string }[]
    }
    const rent = afterTick.expenses.filter((expense) => expense.description === 'Rent')
    expect(rent.map((expense) => expense.date)).toEqual(['2026-10-01'])
  })

  it('converts an itemized foreign receipt and only charges the people on each line', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, {
      now: () => new Date('2026-09-26T16:00:00Z'),
      rateFor: async () => '1.08',
      dev: true,
    })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Dinner', currency: 'USD', timezone: 'America/New_York' }),
    })).json() as { group: { id: string }; members: { id: string }[] }
    const groupId = created.group.id
    const alexId = created.members[0]!.id
    const bobId = ((await (await app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Bob' }),
    })).json()) as { participantId: string }).participantId
    const saved = await app.request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description: 'Itemized dinner',
        date: '2026-09-26',
        originalMinor: 1,
        originalCurrency: 'EUR',
        payers: [{ participantId: alexId, minor: 1 }],
        items: [
          { label: 'Steak', minor: 2000, participantIds: [alexId] },
          { label: 'Salad', minor: 1000, participantIds: [bobId] },
        ],
        taxMinor: 200,
        tipMinor: 0,
        discountMinor: 0,
      }),
    })
    expect(saved.status).toBe(200)
    const detail = await (await app.request(`/api/groups/${groupId}`, { headers: auth })).json() as {
      expenses: {
        description: string
        originalMinor: number
        originalCurrency: string
        settlementMinor: number
        overridden: boolean
        shares: { participantId: string; minor: number }[]
      }[]
    }
    const expense = detail.expenses.find((row) => row.description === 'Itemized dinner')
    expect(expense?.originalCurrency).toBe('EUR')
    expect(expense?.originalMinor).toBe(3200)
    expect(expense?.settlementMinor).toBe(3456)
    expect(expense?.overridden).toBe(false)
    expect(expense?.shares).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: alexId, minor: 2304 }),
      expect.objectContaining({ participantId: bobId, minor: 1152 }),
    ]))
    expect(expense?.shares.reduce((sum, share) => sum + share.minor, 0)).toBe(3456)
  })

  it('reads category and month charts back from the group', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, {
      now: () => new Date('2026-09-26T15:00:00Z'),
      rateFor: async () => '1',
      dev: true,
    })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Charts', currency: 'USD', timezone: 'America/New_York' }),
    })).json() as { group: { id: string }; members: { id: string }[] }
    const groupId = created.group.id
    const alexId = created.members[0]!.id
    const bobId = ((await (await app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Bob' }),
    })).json()) as { participantId: string }).participantId
    const add = (description: string, date: string, categoryId: string, minor: number) => app.request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description,
        date,
        categoryId,
        originalMinor: minor,
        originalCurrency: 'USD',
        payers: [{ participantId: alexId, minor }],
        split: { type: 'equal', participantIds: [alexId, bobId] },
      }),
    })
    expect((await add('August rent', '2026-08-15', 'cat_rent', 3000)).status).toBe(200)
    expect((await add('September dinner', '2026-09-02', 'cat_dining', 2000)).status).toBe(200)
    const month = await (await app.request(`/api/groups/${groupId}/charts`, { headers: auth })).json() as {
      categories: { categoryId: string; label: string; shareMinor: number; paidMinor: number }[]
      months: { month: string; shareMinor: number }[]
    }
    expect(month.categories).toEqual([
      expect.objectContaining({ categoryId: 'cat_dining', label: 'Dining', shareMinor: 1000, paidMinor: 2000 }),
    ])
    expect(month.months.map((row) => row.month)).toEqual(['2026-09'])
    const all = await (await app.request(`/api/groups/${groupId}/charts?from=0001-01-01&to=9999-12-31`, { headers: auth })).json() as {
      entries: { month: string; categoryId: string; label: string; shareMinor: number; paidMinor: number }[]
    }
    expect(all.entries).toEqual([
      expect.objectContaining({ month: '2026-08', categoryId: 'cat_rent', label: 'Rent', shareMinor: 1500, paidMinor: 3000 }),
      expect.objectContaining({ month: '2026-09', categoryId: 'cat_dining', label: 'Dining', shareMinor: 1000, paidMinor: 2000 }),
    ])
  })
})
