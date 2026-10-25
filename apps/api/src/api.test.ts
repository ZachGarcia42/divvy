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

  it('stores a blank expense description and still requires other names', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { now: () => new Date('2026-09-26T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }),
    })).json() as { group: { id: string }; members: { id: string }[] }
    const groupId = created.group.id
    const alexId = created.members[0]!.id
    const bobId = ((await (await app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Bob' }),
    })).json()) as { participantId: string }).participantId

    const blankGroup = await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: '   ', currency: 'USD', timezone: 'UTC' }),
    })
    expect(blankGroup.status).toBe(400)
    expect(await blankGroup.json()).toMatchObject({ error: { code: 'BAD_NAME' } })
    const blankPerson = await app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: ' ' }),
    })
    expect(blankPerson.status).toBe(400)
    expect(await blankPerson.json()).toMatchObject({ error: { code: 'BAD_NAME' } })

    const save = (description: string) => app.request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description,
        originalMinor: 1000,
        originalCurrency: 'USD',
        payers: [{ participantId: alexId, minor: 1000 }],
        split: { type: 'equal', participantIds: [alexId, bobId] },
      }),
    })
    expect((await save('')).status).toBe(200)
    expect((await save('   ')).status).toBe(200)
    expect((await save('Dinner')).status).toBe(200)
    const detail = await (await app.request(`/api/groups/${groupId}`, { headers: auth })).json() as {
      expenses: { description: string }[]
    }
    expect(detail.expenses.map((expense) => expense.description).sort()).toEqual(['', '', 'Dinner'])
    const activity = await (await app.request(`/api/groups/${groupId}/activity`, { headers: auth })).json() as { summary: string }[]
    expect(activity.some((row) => row.summary === 'Alex added an expense')).toBe(true)
    expect(activity.some((row) => /\bExpense\b/.test(row.summary))).toBe(false)
  })

  it('rejects exact shares that do not add up to the total', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { now: () => new Date('2026-09-26T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }),
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
        description: 'Uneven',
        originalMinor: 1000,
        originalCurrency: 'USD',
        payers: [{ participantId: alexId, minor: 1000 }],
        split: { type: 'exact', amounts: [
          { participantId: alexId, minor: 600 },
          { participantId: bobId, minor: 300 },
        ] },
      }),
    })
    expect(saved.status).toBe(400)
    expect(await saved.json()).toMatchObject({ error: { code: 'UNBALANCED' } })
    const detail = await (await app.request(`/api/groups/${groupId}`, { headers: auth })).json() as { expenses: unknown[] }
    expect(detail.expenses).toHaveLength(0)
  })

  it('returns 400 BAD_SPLIT, not 500, for malformed split shapes', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { now: () => new Date('2026-09-26T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }),
    })).json() as { group: { id: string }; members: { id: string }[] }
    const groupId = created.group.id
    const alexId = created.members[0]!.id
    const splits: unknown[] = [
      { type: 'exact' }, { type: 'exact', amounts: null }, { type: 'exact', amounts: 'x' },
      { type: 'exact', amounts: [{ participantId: alexId, minor: '1000' }] },
      { type: 'percent' }, { type: 'shares' }, { type: 'shares', parts: [null] },
      { type: 'equal' }, { type: 'equal', participantIds: 'x' }, { type: 'zzz' }, 'equal', [1],
    ]
    for (const split of splits) {
      const saved = await app.request(`/api/groups/${groupId}/expenses`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ description: 'Bad', originalMinor: 1000, originalCurrency: 'USD', payers: [{ participantId: alexId, minor: 1000 }], split }),
      })
      expect(saved.status, JSON.stringify(split)).toBe(400)
      expect(await saved.json()).toMatchObject({ error: { code: 'BAD_SPLIT' } })
    }
  })

  it('splits $10 three ways as 334, 333, and 333 cents with the extra cent on the lowest id', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { now: () => new Date('2026-09-26T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }),
    })).json() as { group: { id: string }; members: { id: string }[] }
    const groupId = created.group.id
    const alexId = created.members[0]!.id
    const bobId = ((await (await app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Bob' }),
    })).json()) as { participantId: string }).participantId
    const charlieId = ((await (await app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Charlie' }),
    })).json()) as { participantId: string }).participantId
    const saved = await app.request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description: 'Ten dollars',
        originalMinor: 1000,
        originalCurrency: 'USD',
        payers: [{ participantId: alexId, minor: 1000 }],
        split: { type: 'equal', participantIds: [charlieId, alexId, bobId] },
      }),
    })
    expect(saved.status).toBe(200)
    const detail = await (await app.request(`/api/groups/${groupId}`, { headers: auth })).json() as {
      expenses: { shares: { participantId: string; minor: number }[] }[]
    }
    const shares = detail.expenses[0]!.shares
    expect(shares.map((share) => share.minor).sort((a, b) => a - b)).toEqual([333, 333, 334])
    expect(shares.reduce((sum, share) => sum + share.minor, 0)).toBe(1000)
    const lowest = shares.reduce((best, share) => share.participantId < best.participantId ? share : best)
    expect(lowest.minor).toBe(334)
  })

  it('restores the balance when a recorded settlement is undone', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { now: () => new Date('2026-09-26T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }),
    })).json() as { group: { id: string }; members: { id: string }[] }
    const groupId = created.group.id
    const alexId = created.members[0]!.id
    const bobId = ((await (await app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ displayName: 'Bob' }),
    })).json()) as { participantId: string }).participantId
    expect((await app.request(`/api/groups/${groupId}/expenses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        description: 'Groceries',
        originalMinor: 2000,
        originalCurrency: 'USD',
        payers: [{ participantId: alexId, minor: 2000 }],
        split: { type: 'equal', participantIds: [alexId, bobId] },
      }),
    })).status).toBe(200)

    const before = await (await app.request(`/api/groups/${groupId}`, { headers: auth })).json() as {
      nets: { participantId: string; netMinor: number }[]
      payments: { fromId: string; toId: string; minor: number }[]
    }
    expect(before.payments).toEqual([{ fromId: bobId, toId: alexId, minor: 1000 }])
    expect(before.nets.find((row) => row.participantId === alexId)?.netMinor).toBe(1000)
    expect(before.nets.find((row) => row.participantId === bobId)?.netMinor).toBe(-1000)

    const recorded = await app.request(`/api/groups/${groupId}/settlements`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ fromId: bobId, toId: alexId, minor: 1000 }),
    })
    expect(recorded.status).toBe(200)
    const settled = await (await app.request(`/api/groups/${groupId}`, { headers: auth })).json() as {
      nets: { participantId: string; netMinor: number }[]
      payments: { fromId: string; toId: string; minor: number }[]
      settlements: { id: string }[]
    }
    expect(settled.payments).toEqual([])
    expect(settled.nets.find((row) => row.participantId === alexId)?.netMinor ?? 0).toBe(0)
    expect(settled.nets.find((row) => row.participantId === bobId)?.netMinor ?? 0).toBe(0)
    const settlementId = settled.settlements[0]!.id

    const undone = await app.request(`/api/groups/${groupId}/settlements/${settlementId}`, { method: 'DELETE', headers: auth })
    expect(undone.status).toBe(200)
    const restored = await (await app.request(`/api/groups/${groupId}`, { headers: auth })).json() as {
      nets: { participantId: string; netMinor: number }[]
      payments: { fromId: string; toId: string; minor: number }[]
      settlements: { id: string }[]
    }
    expect(restored.payments).toEqual([{ fromId: bobId, toId: alexId, minor: 1000 }])
    expect(restored.nets.find((row) => row.participantId === alexId)?.netMinor).toBe(1000)
    expect(restored.nets.find((row) => row.participantId === bobId)?.netMinor).toBe(-1000)
    expect(restored.settlements).toEqual([])
  })

  it('lets a different signed-in person accept a group link and keeps email invites locked', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { now: () => new Date('2026-09-26T15:00:00Z'), dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    const jordan = await sessionFor(app, 'jordan@example.com')
    const casey = await sessionFor(app, 'casey@example.com')
    const sam = await sessionFor(app, 'sam@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }),
    })).json() as { group: { id: string }; members: { id: string; name: string }[] }
    const groupId = created.group.id
    const linkResponse = await app.request(`/api/groups/${groupId}/invite-link`, { method: 'POST', headers: auth })
    expect(linkResponse.status).toBe(200)
    const link = await linkResponse.json() as { token: string; url: string }
    expect(link.url).toContain(`/invite/${link.token}`)
    const again = await (await app.request(`/api/groups/${groupId}/invite-link`, { method: 'POST', headers: auth })).json() as { token: string }
    expect(again.token).toBe(link.token)

    const anon = await app.request(`/api/invites/${link.token}/accept`, { method: 'POST' })
    expect(anon.status).toBe(401)

    const preview = await app.request(`/api/invites/${link.token}`, { headers: { authorization: `Bearer ${jordan.token}` } })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ group: { name: 'Apartment' }, kind: 'group' })
    const joined = await app.request(`/api/invites/${link.token}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jordan.token}` },
    })
    expect(joined.status).toBe(200)
    expect((await joined.json() as { members: { name: string }[] }).members.map((member) => member.name).sort()).toEqual(['Alex', 'Jordan'])

    const second = await app.request(`/api/invites/${link.token}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${casey.token}` },
    })
    expect(second.status).toBe(200)
    const names = ((await second.json()) as { members: { name: string }[] }).members.map((member) => member.name).sort()
    expect(names).toEqual(['Alex', 'Casey', 'Jordan'])

    const invited = await app.request(`/api/groups/${groupId}/people`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ email: 'sam@example.com', displayName: 'Sam' }),
    })
    expect(await invited.json()).toMatchObject({ status: 'invited' })
    const outbox = await (await app.request('/api/dev/outbox')).json() as { to_email: string; body: string }[]
    const mail = outbox.find((row) => row.to_email === 'sam@example.com' && row.body.includes('/invite/'))
    const emailToken = mail?.body.split('/invite/').at(-1)?.trim()
    expect(emailToken).toBeTruthy()
    const wrong = await app.request(`/api/invites/${emailToken}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jordan.token}` },
    })
    expect(wrong.status).toBe(403)
    expect(await wrong.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
    const right = await app.request(`/api/invites/${emailToken}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sam.token}` },
    })
    expect(right.status).toBe(200)
    const detail = await (await app.request(`/api/groups/${groupId}`, { headers: { authorization: `Bearer ${sam.token}` } })).json() as {
      members: { name: string }[]
    }
    expect(detail.members.map((member) => member.name)).toContain('Sam')
  })

  it('only hands dev sign-in tokens to allowlisted testers and hides dev routes', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: ' Alex@Example.com , sam@example.com' })
    const ask = async (email: string) => (await app.request('/api/auth/magic-link', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    })).json() as Promise<{ ok: boolean; devToken?: string }>
    const allowed = await ask('alex@example.com')
    expect(allowed.devToken).toBeTruthy()
    expect((await sessionFor(app, 'SAM@example.com')).token).toBeTruthy()
    const stranger = await ask('zach@example.com')
    expect(stranger).toEqual({ ok: true })
    const verify = await app.request('/api/auth/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: stranger.devToken }),
    })
    expect(verify.status).toBe(401)
    expect((await app.request('/api/dev/outbox')).status).toBe(404)
    expect((await app.request('/api/dev/seed', { method: 'POST' })).status).toBe(404)
  })

  it('refuses admin routes without a configured ADMIN_TOKEN', async () => {
    const sql = await createMemorySql()
    const off = createApp(sql, { dev: true, rateFor: async () => '1', adminToken: null }).app
    const refused = await off.request('/api/admin/users/x/suspend', { method: 'POST', headers: { 'x-admin-token': 'dev-admin' } })
    expect(refused.status).toBe(403)
    const on = createApp(sql, { dev: true, rateFor: async () => '1', adminToken: 'secret' }).app
    const user = await sessionFor(on, 'alex@example.com')
    expect((await on.request('/api/admin/users/x/suspend', { method: 'POST', headers: { 'x-admin-token': 'dev-admin' } })).status).toBe(403)
    const me = await (await on.request('/api/me', { headers: { authorization: `Bearer ${user.token}` } })).json() as { userId: string }
    const ok = await on.request(`/api/admin/users/${me.userId}/suspend`, { method: 'POST', headers: { 'x-admin-token': 'secret' } })
    expect(ok.status).toBe(200)
  })

  it('fails closed when DEV_SIGNIN_EMAILS is present but empty', async () => {
    const sql = await createMemorySql()
    const saved = process.env.DEV_SIGNIN_EMAILS
    const ask = async (app: ReturnType<typeof createApp>['app']) => (await app.request('/api/auth/magic-link', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alex@example.com' }),
    })).json() as Promise<{ ok: boolean; devToken?: string }>
    try {
      for (const value of ['', '   ', ' , ']) {
        process.env.DEV_SIGNIN_EMAILS = value
        const { app } = createApp(sql, { dev: true, rateFor: async () => '1' })
        expect(await ask(app)).toEqual({ ok: true })
        expect((await app.request('/api/dev/outbox')).status).toBe(404)
        expect((await app.request('/api/dev/seed', { method: 'POST' })).status).toBe(404)
      }
    } finally {
      if (saved === undefined) delete process.env.DEV_SIGNIN_EMAILS
      else process.env.DEV_SIGNIN_EMAILS = saved
    }
    const locked = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: [] }).app
    expect(await ask(locked)).toEqual({ ok: true })
    expect((await locked.request('/api/dev/outbox')).status).toBe(404)
  })

  it('rejects malformed magic-link bodies with 400', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1' })
    for (const body of ['{"email":null}', '{}', '[]', '{"email":["a@b.co"]}', '{"email":42}', '{"email":{}}', 'null', 'not json']) {
      const response = await app.request('/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(response.status, body).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'BAD_EMAIL' } })
    }
  })

  it('previews an invite publicly with only group, inviter, and status', async () => {
    const sql = await createMemorySql()
    const opts = { dev: true, rateFor: async () => '1', devSigninEmails: null }
    const { app } = createApp(sql, { ...opts, now: () => new Date('2026-09-26T15:00:00Z') })
    const alex = await sessionFor(app, 'alex@example.com')
    const sam = await sessionFor(app, 'sam@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }) })).json() as { group: { id: string } }
    const link = await (await app.request(`/api/groups/${created.group.id}/invite-link`, { method: 'POST', headers: auth })).json() as { token: string }
    const preview = await app.request(`/api/invites/${link.token}/preview`)
    expect(preview.status).toBe(200)
    const body = await preview.json()
    expect(body).toEqual({ groupName: 'Apartment', inviterName: 'Alex', status: 'valid' })
    expect(JSON.stringify(body)).not.toContain('@')
    expect((await app.request('/api/invites/nope-not-a-token/preview')).status).toBe(404)

    await app.request(`/api/groups/${created.group.id}/people`, { method: 'POST', headers: auth, body: JSON.stringify({ email: 'sam@example.com', displayName: 'Sam' }) })
    const outbox = await (await app.request('/api/dev/outbox')).json() as { to_email: string; body: string }[]
    const emailToken = outbox.find((row) => row.to_email === 'sam@example.com' && row.body.includes('/invite/'))!.body.split('/invite/').at(-1)!.trim()
    await app.request(`/api/invites/${emailToken}/accept`, { method: 'POST', headers: { authorization: `Bearer ${sam.token}` } })
    expect(await (await app.request(`/api/invites/${emailToken}/preview`)).json()).toMatchObject({ status: 'used' })

    const later = createApp(sql, { ...opts, now: () => new Date('2026-10-20T15:00:00Z') }).app
    expect(await (await later.request(`/api/invites/${link.token}/preview`)).json()).toMatchObject({ status: 'expired' })
  })

  it('carries a relative next path through the email link and verify, and rejects absolute ones', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null })
    const send = (body: unknown) => app.request('/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const issued = await (await send({ email: 'alex@example.com', next: '/invite/abc123' })).json() as { devToken: string }
    const outbox = await (await app.request('/api/dev/outbox')).json() as { to_email: string; body: string }[]
    expect(outbox.at(-1)!.body).toContain('&next=%2Finvite%2Fabc123')
    const verified = await (await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: issued.devToken }) })).json()
    expect(verified).toMatchObject({ next: '/invite/abc123' })
    const plain = await (await send({ email: 'sam@example.com' })).json() as { devToken: string }
    expect(await (await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: plain.devToken }) })).json()).toMatchObject({ next: null })
    for (const next of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', 'invite/abc', '/\\evil.example', '/a b', 42]) {
      const response = await send({ email: 'jo@example.com', next })
      expect(response.status, String(next)).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'BAD_NEXT' } })
    }
  })

  it('rejects blank and non-string display names with 400', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null })
    const alex = await sessionFor(app, 'alex@example.com')
    const patch = (body: string) => app.request('/api/me', { method: 'PATCH', headers: { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }, body })
    const blank = await patch(JSON.stringify({ displayName: '   ' }))
    expect(blank.status).toBe(400)
    expect(await blank.json()).toMatchObject({ error: { code: 'BAD_NAME', message: "Name can't be blank" } })
    for (const body of [{ displayName: 42 }, { displayName: null }, { displayName: ['Al'] }, { homeCurrency: 5 }]) {
      expect((await patch(JSON.stringify(body))).status, JSON.stringify(body)).toBe(400)
    }
    expect((await patch('[]')).status).toBe(400)
    expect(await (await patch(JSON.stringify({ displayName: ' Alexandra ' }))).json()).toMatchObject({ displayName: 'Alexandra' })
  })

  it('rate-limits sign-in links per email and per IP', async () => {
    const sql = await createMemorySql()
    let now = new Date('2026-09-26T15:00:00Z').getTime()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null, trustProxy: true, now: () => new Date(now) })
    const send = (email: string, ip: string) => app.request('/api/auth/magic-link', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email }),
    })
    for (let i = 0; i < 5; i += 1) expect((await send('Alex@example.com', `10.0.0.${i}`)).status).toBe(200)
    const limited = await send('alex@example.com ', '10.0.1.1')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    for (let i = 0; i < 5; i += 1) expect((await send(`p${i}@example.com`, '10.9.9.9')).status).toBe(200)
    expect((await send('fresh@example.com', '10.9.9.9')).status).toBe(429)
    expect((await send('fresh@example.com', '10.9.9.8')).status).toBe(200)
    now += 15 * 60 * 1000
    expect((await send('alex@example.com', '10.9.9.9')).status).toBe(200)
  })

  it('rejects next paths with "//" anywhere or dot segments, raw or encoded', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null, rateLimit: false })
    const send = (next: string) => app.request('/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'n@example.com', next }) })
    for (const next of ['/..//evil.com', '/.//evil.com', '/a//b', '/a/../b', '/..', '/./x', '/%2F%2Fevil.com', '/..%2F..%2Fevil.com', '/%5Cevil.com', '/%E0%A4%A', '/javascript:alert(1)', '/%6Aavascript:x']) {
      expect((await send(next)).status, next).toBe(400)
    }
    for (const next of ['/invite/abc_DEF-123', '/groups/x?tab=1#y', '/', '/a/b/c', '/a..b/c']) {
      expect((await send(next)).status, next).toBe(200)
    }
  })

  it('takes the last X-Forwarded-For entry when trusting a proxy', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null, trustProxy: true })
    const send = (email: string, xff: string) => app.request('/api/auth/magic-link', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ email }),
    })
    for (let i = 0; i < 5; i += 1) expect((await send(`x${i}@example.com`, `6.6.6.${i}, 203.0.113.7`)).status).toBe(200)
    expect((await send('x9@example.com', '6.6.6.99, 203.0.113.7')).status).toBe(429)
  })

  it('refuses blank or non-string group names on update', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }) })).json() as { group: { id: string } }
    for (const name of ['', '   ', null, 42, ['x']]) {
      const response = await app.request(`/api/groups/${created.group.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ name }) })
      expect(response.status, JSON.stringify(name)).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'BAD_NAME' } })
    }
    expect((await app.request(`/api/groups/${created.group.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ name: ' Flat ' }) })).status).toBe(200)
    expect(await (await app.request(`/api/groups/${created.group.id}`, { headers: auth })).json()).toMatchObject({ group: { name: 'Flat' } })
  })

  it('shows archived groups as archived in the preview and refuses to join them', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null })
    const alex = await sessionFor(app, 'alex@example.com')
    const jordan = await sessionFor(app, 'jordan@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Old', currency: 'USD', timezone: 'UTC' }) })).json() as { group: { id: string } }
    const link = await (await app.request(`/api/groups/${created.group.id}/invite-link`, { method: 'POST', headers: auth })).json() as { token: string }
    await app.request(`/api/groups/${created.group.id}/archive`, { method: 'POST', headers: auth })
    expect(await (await app.request(`/api/invites/${link.token}/preview`)).json()).toEqual({ groupName: 'Old', inviterName: 'Alex', status: 'archived' })
    const accept = await app.request(`/api/invites/${link.token}/accept`, { method: 'POST', headers: { authorization: `Bearer ${jordan.token}` } })
    expect(accept.status).toBe(410)
    expect(await accept.json()).toMatchObject({ error: { code: 'ARCHIVED' } })
    await app.request(`/api/groups/${created.group.id}/unarchive`, { method: 'POST', headers: auth })
    expect(await (await app.request(`/api/invites/${link.token}/preview`)).json()).toMatchObject({ status: 'valid' })
  })

  it('signs in an email whose local part is over 80 characters with a truncated name', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null })
    const session = await sessionFor(app, `${'l'.repeat(120)}@example.com`)
    expect(session.token).toBeTruthy()
    expect(session.user.displayName).toBe('L' + 'l'.repeat(79))
    const long = await app.request('/api/me', { method: 'PATCH', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'x'.repeat(81) }) })
    expect(await long.json()).toMatchObject({ error: { code: 'BAD_NAME', message: 'Use a name of 80 characters or fewer' } })
  })

  it('tells a member reopening their used invite that they are already in, and exposes /api/config', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null })
    expect(await (await app.request('/api/config')).json()).toEqual({ devSeed: true })
    const locked = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: [] }).app
    expect(await (await locked.request('/api/config')).json()).toEqual({ devSeed: false })
    const alex = await sessionFor(app, 'alex@example.com')
    const sam = await sessionFor(app, 'sam@example.com')
    const jo = await sessionFor(app, 'jo@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const created = await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Apartment', currency: 'USD', timezone: 'UTC' }) })).json() as { group: { id: string } }
    await app.request(`/api/groups/${created.group.id}/people`, { method: 'POST', headers: auth, body: JSON.stringify({ email: 'sam@example.com', displayName: 'Sam' }) })
    const outbox = await (await app.request('/api/dev/outbox')).json() as { to_email: string; body: string }[]
    const tok = outbox.find((row) => row.to_email === 'sam@example.com' && row.body.includes('/invite/'))!.body.split('/invite/').at(-1)!.trim()
    const before = await (await app.request(`/api/invites/${tok}`, { headers: { authorization: `Bearer ${sam.token}` } })).json()
    expect(before).toMatchObject({ youAreMember: false })
    await app.request(`/api/invites/${tok}/accept`, { method: 'POST', headers: { authorization: `Bearer ${sam.token}` } })
    const again = await app.request(`/api/invites/${tok}`, { headers: { authorization: `Bearer ${sam.token}` } })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ group: { name: 'Apartment' }, youAreMember: true })
    const other = await app.request(`/api/invites/${tok}`, { headers: { authorization: `Bearer ${jo.token}` } })
    expect(other.status).toBe(403)
    expect(await other.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  })

  it('validates comments: target type, target in group, and body', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { now: () => new Date('2026-09-26T15:00:00Z'), rateFor: async () => '1', dev: true })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const mk = async (name: string) => (await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name, currency: 'USD', timezone: 'UTC' }) })).json()) as { group: { id: string }; members: { id: string }[] }
    const g = await mk('Home')
    const other = await mk('Other')
    const me = g.members[0]!.id
    const bob = ((await (await app.request(`/api/groups/${g.group.id}/people`, { method: 'POST', headers: auth, body: JSON.stringify({ displayName: 'Bob' }) })).json()) as { participantId: string }).participantId
    const expense = await (await app.request(`/api/groups/${g.group.id}/expenses`, { method: 'POST', headers: auth, body: JSON.stringify({
      description: 'Milk', date: '2026-09-01', originalMinor: 500, originalCurrency: 'USD',
      payers: [{ participantId: me, minor: 500 }], split: { type: 'exact', amounts: [{ participantId: me, minor: 250 }, { participantId: bob, minor: 250 }] },
    }) })).json() as { id: string }
    expect(expense.id, JSON.stringify(expense)).toBeTruthy()
    const post = (groupId: string, body: unknown) => app.request(`/api/groups/${groupId}/comments`, { method: 'POST', headers: auth, body: typeof body === 'string' ? body : JSON.stringify(body) })
    const ok = { targetType: 'expense', targetId: expense.id, body: 'nice' }
    for (const bad of [
      { body: 'x' },
      { ...ok, targetType: 'group' },
      { ...ok, targetType: 7 },
      { ...ok, targetId: '' },
      { ...ok, targetId: '   ' },
      { ...ok, targetId: 42 },
      { ...ok, body: '' },
      { ...ok, body: '   ' },
      { ...ok, body: null },
      { ...ok, body: 'a'.repeat(2001) },
      '[]',
      'not json',
    ]) {
      const res = await post(g.group.id, bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_COMMENT')
    }
    expect((await post(g.group.id, { ...ok, targetId: 'nope' })).status).toBe(404)
    expect((await post(g.group.id, { ...ok, targetType: 'settlement' })).status).toBe(404)
    expect((await post(other.group.id, ok)).status).toBe(404)
    expect((await post(g.group.id, { ...ok, body: 'a'.repeat(2000) })).status).toBe(200)
    expect((await post(g.group.id, ok)).status).toBe(200)
    const list = await (await app.request(`/api/groups/${g.group.id}/comments?targetId=${expense.id}`, { headers: auth })).json() as unknown[]
    expect(list).toHaveLength(2)
  })

  describe('sign-in codes', () => {
    const json = { 'content-type': 'application/json' }
    const make = async (over: Parameters<typeof createApp>[1] = {}) => {
      let now = new Date('2026-10-13T10:00:00Z').getTime()
      const sql = await createMemorySql()
      const made = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null, now: () => new Date(now), ...over })
      const app = made.app
      const request = async (email: string, next?: string) => (await app.request('/api/auth/magic-link', { method: 'POST', headers: json, body: JSON.stringify(next ? { email, next } : { email }) })).json() as Promise<{ devToken?: string; devCode?: string }>
      const code = (email: string, value: string) => app.request('/api/auth/verify-code', { method: 'POST', headers: json, body: JSON.stringify({ email, code: value }) })
      const link = (token: string) => app.request('/api/auth/verify', { method: 'POST', headers: json, body: JSON.stringify({ token }) })
      const wrong = (right: string) => String((Number(right) + 1) % 1_000_000).padStart(6, '0')
      return { app, request, code, link, wrong, advance: (ms: number) => { now += ms } }
    }

    it('signs in with the emailed code and carries next', async () => {
      const t = await make()
      const issued = await t.request('Alex@Example.com', '/invite/abc')
      expect(issued.devCode).toMatch(/^\d{6}$/)
      const outbox = await (await t.app.request('/api/dev/outbox')).json() as { subject: string; body: string }[]
      expect(outbox.at(-1)!.subject).toBe(`${issued.devCode} is your Divvy sign-in code`)
      expect(outbox.at(-1)!.body.split('\n')[0]).toContain(issued.devCode)
      expect(outbox.at(-1)!.body).toContain('/login?token=')
      const response = await t.code(' alex@example.com ', issued.devCode!)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ token: expect.any(String), user: { email: 'alex@example.com' }, next: '/invite/abc' })
    })

    it('rejects bad input with 400', async () => {
      const t = await make()
      for (const body of [{ email: 'a@b.co' }, { email: 'a@b.co', code: '12345' }, { email: 'a@b.co', code: 123456 }, { email: 'a@b.co', code: '12a456' }, { code: '123456' }, { email: 'nope', code: '123456' }]) {
        const response = await t.app.request('/api/auth/verify-code', { method: 'POST', headers: json, body: JSON.stringify(body) })
        expect(response.status, JSON.stringify(body)).toBe(400)
      }
    })

    it('counts wrong codes down and locks on the 5th', async () => {
      const t = await make()
      const issued = await t.request('alex@example.com')
      for (const left of [4, 3, 2, 1]) {
        const response = await t.code('alex@example.com', t.wrong(issued.devCode!))
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error: { code: 'BAD_CODE', attemptsLeft: left } })
      }
      const locked = await t.code('alex@example.com', t.wrong(issued.devCode!))
      expect(locked.status).toBe(401)
      expect(await locked.json()).toEqual({ error: { code: 'CODE_LOCKED', message: 'Too many tries. Get a new code below.' } })
      // The right code no longer works once locked; the link still does.
      expect(await (await t.code('alex@example.com', issued.devCode!)).json()).toMatchObject({ error: { code: 'CODE_EXPIRED' } })
      expect((await t.link(issued.devToken!)).status).toBe(200)
    })

    it('treats a locked code as expired after Resend without burning a try on the new code', async () => {
      const t = await make()
      const first = await t.request('alex@example.com')
      for (let i = 0; i < 5; i += 1) await t.code('alex@example.com', t.wrong(first.devCode!))
      const second = await t.request('alex@example.com')
      if (second.devCode === first.devCode) return // 1-in-a-million collision; nothing to distinguish
      const old = await t.code('alex@example.com', first.devCode!)
      expect(old.status).toBe(401)
      expect(await old.json()).toMatchObject({ error: { code: 'CODE_EXPIRED' } })
      const bad = await t.code('alex@example.com', t.wrong(second.devCode!) === first.devCode ? t.wrong(t.wrong(second.devCode!)) : t.wrong(second.devCode!))
      expect(await bad.json()).toMatchObject({ error: { code: 'BAD_CODE', attemptsLeft: 4 } })
      expect((await t.code('alex@example.com', second.devCode!)).status).toBe(200)
    })

    it('expires codes after 10 minutes while the link lasts 15', async () => {
      const t = await make()
      const issued = await t.request('alex@example.com')
      t.advance(10 * 60 * 1000 + 1)
      const response = await t.code('alex@example.com', issued.devCode!)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: 'CODE_EXPIRED' } })
      expect((await t.link(issued.devToken!)).status).toBe(200)
    })

    it('invalidates the old code on resend', async () => {
      const t = await make()
      const first = await t.request('alex@example.com')
      const second = await t.request('alex@example.com')
      if (first.devCode !== second.devCode) {
        const old = await t.code('alex@example.com', first.devCode!)
        expect(old.status).toBe(401)
        expect(await old.json()).toMatchObject({ error: { code: 'CODE_EXPIRED' } })
      }
      expect((await t.code('alex@example.com', second.devCode!)).status).toBe(200)
    })

    it('leaves exactly one live code when two requests race', async () => {
      const t = await make()
      const [a, b] = await Promise.all([t.request('race@example.com'), t.request('race@example.com')])
      expect(a.devCode && b.devCode).toBeTruthy()
      const results = []
      for (const issued of [a, b]) results.push((await t.code('race@example.com', issued.devCode!)).status)
      expect(results.filter((status) => status === 200)).toHaveLength(1)
    })

    it('does not count a superseded code against the new one', async () => {
      const t = await make()
      const first = await t.request('alex@example.com')
      const second = await t.request('alex@example.com')
      if (first.devCode === second.devCode) return // 1-in-a-million collision; nothing to distinguish
      for (let i = 0; i < 7; i += 1) {
        expect(await (await t.code('alex@example.com', first.devCode!)).json()).toMatchObject({ error: { code: 'CODE_EXPIRED' } })
      }
      // A code that matches neither request.
      const wrong = t.wrong(second.devCode!)
      const notEither = wrong === first.devCode ? t.wrong(wrong) : wrong
      expect(await (await t.code('alex@example.com', notEither)).json()).toMatchObject({ error: { code: 'BAD_CODE', attemptsLeft: 4 } })
      expect((await t.code('alex@example.com', second.devCode!)).status).toBe(200)
      // The superseded request's link still works until it expires.
      const third = await t.request('sam@example.com')
      await t.request('sam@example.com')
      expect((await t.link(third.devToken!)).status).toBe(200)
    })

    it('stops recognizing superseded codes once they would have expired', async () => {
      const t = await make()
      const first = await t.request('alex@example.com')
      t.advance(9 * 60 * 1000)
      const second = await t.request('alex@example.com')
      if (first.devCode === second.devCode) return
      t.advance(2 * 60 * 1000)
      expect(await (await t.code('alex@example.com', first.devCode!)).json()).toMatchObject({ error: { code: 'BAD_CODE', attemptsLeft: 4 } })
      expect((await t.code('alex@example.com', second.devCode!)).status).toBe(200)
    })

    it('gives the real user fresh code attempts after a Resend and keeps the link working after a lock', async () => {
      const t = await make({ trustProxy: true })
      const at = (code: string, ip: string) => t.app.request('/api/auth/verify-code', { method: 'POST', headers: { ...json, 'x-forwarded-for': ip }, body: JSON.stringify({ email: 'victim@example.com', code }) })
      const first = await t.request('victim@example.com')
      // An attacker who only knows the email burns the code and the per-email bucket for this request.
      const statuses: number[] = []
      for (let i = 0; i < 11; i += 1) statuses.push((await at(t.wrong(first.devCode!), `10.3.0.${i}`)).status)
      expect(statuses[4]).toBe(401)
      expect(statuses[10]).toBe(429)
      expect((await t.link(first.devToken!)).status).toBe(200)
      // The real user taps Resend: a new request means a fresh per-email bucket and fresh attempts.
      const second = await t.request('victim@example.com')
      const bad = await at(t.wrong(second.devCode!) === first.devCode ? t.wrong(t.wrong(second.devCode!)) : t.wrong(second.devCode!), '192.0.2.10')
      const badBody = await bad.json()
      expect(badBody, JSON.stringify(badBody)).toMatchObject({ error: { code: 'BAD_CODE', attemptsLeft: 4 } })
      expect((await at(second.devCode!, '192.0.2.10')).status).toBe(200)
      // Per-IP stays: one IP can't spray codes across many requests.
      const ip: number[] = []
      for (let i = 0; i < 11; i += 1) ip.push((await at('000000', '10.4.4.4')).status)
      expect(ip[10]).toBe(429)
    })

    it('makes the link and the code mutually exclusive', async () => {
      const t = await make()
      const a = await t.request('alex@example.com')
      expect((await t.code('alex@example.com', a.devCode!)).status).toBe(200)
      expect(await (await t.link(a.devToken!)).json()).toMatchObject({ error: { code: 'BAD_TOKEN' } })
      const b = await t.request('sam@example.com')
      expect((await t.link(b.devToken!)).status).toBe(200)
      expect(await (await t.code('sam@example.com', b.devCode!)).json()).toMatchObject({ error: { code: 'CODE_EXPIRED' } })
    })

    it('rate-limits code checks per email and per IP', async () => {
      const t = await make({ trustProxy: true })
      const at = (email: string, ip: string) => t.app.request('/api/auth/verify-code', { method: 'POST', headers: { ...json, 'x-forwarded-for': ip }, body: JSON.stringify({ email, code: '000000' }) })
      const statuses: number[] = []
      for (let i = 0; i < 11; i += 1) statuses.push((await at('victim@example.com', `10.1.0.${i}`)).status)
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true)
      expect(statuses[10]).toBe(429)
      const ip: number[] = []
      for (let i = 0; i < 11; i += 1) ip.push((await at(`p${i}@example.com`, '10.2.2.2')).status)
      expect(ip[10]).toBe(429)
    })

    it('returns devCode only when devToken is returned', async () => {
      const t = await make({ devSigninEmails: 'tester@example.com' })
      expect(await t.request('tester@example.com')).toMatchObject({ devToken: expect.any(String), devCode: expect.stringMatching(/^\d{6}$/) })
      expect(await t.request('stranger@example.com')).toEqual({ ok: true })
      const prod = await make({ dev: false })
      expect(await prod.request('tester@example.com')).toEqual({ ok: true })
    })
  })

  it('serves escaped landing pages for sign-in and invite links', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1' })
    const token = 'abcDEF_123-xyz7890'
    const invite = await app.request(`/invite/${token}`)
    expect(invite.status).toBe(200)
    expect(invite.headers.get('content-type')).toMatch(/text\/html/)
    const html = await invite.text()
    expect(html).toContain(`href="divvy://invite/${token}"`)
    expect(html).toContain('Open in the Divvy app')
    expect(html).not.toContain('http-equiv="refresh"')
    expect(html).toContain('#0f766e')
    const mobile = await (await app.request(`/invite/${token}`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' } })).text()
    expect(mobile).toContain('http-equiv="refresh"')
    expect(html).toContain('Need the app? It’s in testing.')
    const login = await (await app.request(`/login?token=${token}&next=${encodeURIComponent('/invite/abc')}`)).text()
    expect(login).toContain(`href="divvy://login?token=${token}&amp;next=%2Finvite%2Fabc"`)
    const evilNext = await (await app.request(`/login?token=${token}&next=${encodeURIComponent('//evil.com')}`)).text()
    expect(evilNext).toContain(`href="divvy://login?token=${token}"`)
    for (const path of ['/invite/short', `/invite/${encodeURIComponent('<script>alert(1)</script>aaaaaaaaaa')}`, '/login', `/login?token=${encodeURIComponent('"><b>xxxxxxxxxxxxxxxx')}`]) {
      const response = await app.request(path)
      expect(response.status, path).toBe(400)
      const body = await response.text()
      expect(body).not.toContain('<script>alert')
      expect(body).not.toContain('<b>')
      expect(body).not.toContain('divvy://')
    }
  })

  it('personalizes the invite landing page from the preview, escaped, with a generic fallback', async () => {
    const sql = await createMemorySql()
    let now = new Date('2026-09-26T15:00:00Z')
    const { app } = createApp(sql, { now: () => now, dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    await app.request('/api/me', { method: 'PATCH', headers: auth, body: JSON.stringify({ displayName: 'Al <b>&' }) })
    const inviter = 'Al <b>&'
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    const created = await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Design <i>review</i>', currency: 'USD', timezone: 'UTC' }) })).json() as { group: { id: string } }
    const link = await (await app.request(`/api/groups/${created.group.id}/invite-link`, { method: 'POST', headers: auth })).json() as { token: string }
    const html = await (await app.request(`/invite/${link.token}`)).text()
    expect(html).toContain(esc(`${inviter} invited you to Design <i>review</i>`))
    expect(html).not.toContain('<i>review')
    expect(html).toContain(`<h1><bdi>${esc(inviter)}</bdi> invited you to <bdi>${esc('Design <i>review</i>')}</bdi></h1>`)
    await app.request('/api/me', { method: 'PATCH', headers: auth, body: JSON.stringify({ displayName: 'Eve\u202Eolleh\u2066x\u2069' }) })
    const bidiHtml = await (await app.request(`/invite/${link.token}`)).text()
    expect(bidiHtml).toContain('<bdi>Eveollehx</bdi> invited you to')
    expect(bidiHtml).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/)
    await app.request('/api/me', { method: 'PATCH', headers: auth, body: JSON.stringify({ displayName: inviter }) })
    expect(html).toContain(`href="divvy://invite/${link.token}"`)
    const unknown = await (await app.request('/invite/abcDEF_123-unknown0')).text()
    expect(unknown).toContain('You’re invited to a Divvy group')
    expect(unknown).not.toContain('Design')
    const other = await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Old trip', currency: 'USD', timezone: 'UTC' }) })).json() as { group: { id: string } }
    const otherLink = await (await app.request(`/api/groups/${other.group.id}/invite-link`, { method: 'POST', headers: auth })).json() as { token: string }
    expect((await app.request(`/api/groups/${other.group.id}/archive`, { method: 'POST', headers: auth })).status).toBe(200)
    const archived = await (await app.request(`/invite/${otherLink.token}`)).text()
    expect(archived).toContain('You’re invited to a Divvy group')
    expect(archived).not.toContain('Old trip')
    now = new Date('2027-09-26T15:00:00Z')
    const expired = await (await app.request(`/invite/${link.token}`)).text()
    expect(expired).toContain('You’re invited to a Divvy group')
    expect(expired).not.toContain('Design')
  })

  it('reports the build on /api/health', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', build: 'abc1234' })
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true, build: 'abc1234' })
    const { resolveBuild } = await import('./app.ts')
    expect(resolveBuild('  f00ba47 ', '/nonexistent/BUILD')).toBe('f00ba47')
    expect(resolveBuild(undefined, '/nonexistent/BUILD')).toBe('dev')
    expect(resolveBuild('', '/nonexistent/BUILD')).toBe('dev')
  })

  it('sends RateLimit headers and Retry-After on 429', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1', devSigninEmails: null })
    const send = () => app.request('/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'rl@example.com' }) })
    const first = await send()
    expect(first.headers.get('RateLimit-Limit')).toBe('5')
    expect(first.headers.get('RateLimit-Remaining')).toBe('4')
    expect(Number(first.headers.get('RateLimit-Reset'))).toBeGreaterThan(0)
    for (let i = 0; i < 4; i += 1) await send()
    const limited = await send()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(limited.headers.get('RateLimit-Remaining')).toBe('0')
  })

  it('caps expenses, treats blank exact shares as 0, and names the description', async () => {
    const sql = await createMemorySql()
    const { app } = createApp(sql, { dev: true, rateFor: async () => '1' })
    const alex = await sessionFor(app, 'alex@example.com')
    const auth = { authorization: `Bearer ${alex.token}`, 'content-type': 'application/json' }
    const group = await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Trip', currency: 'USD', timezone: 'UTC' }) })).json() as { group: { id: string }; members: { id: string }[] }
    const bobId = ((await (await app.request(`/api/groups/${group.group.id}/people`, { method: 'POST', headers: auth, body: JSON.stringify({ displayName: 'Bob' }) })).json()) as { participantId: string }).participantId
    const alexId = group.members[0]!.id
    const post = (body: Record<string, unknown>) => app.request(`/api/groups/${group.group.id}/expenses`, { method: 'POST', headers: auth, body: JSON.stringify({ description: 'Dinner', date: '2026-09-01', originalCurrency: 'USD', ...body }) })
    const big = await post({ originalMinor: 10_000_001, payers: [{ participantId: alexId, minor: 10_000_001 }], split: { type: 'equal', participantIds: [alexId, bobId] } })
    expect(big.status).toBe(400)
    expect(JSON.stringify(await big.json())).toContain('at most $100,000.00')
    const max = await post({ originalMinor: 10_000_000, payers: [{ participantId: alexId, minor: 10_000_000 }], split: { type: 'equal', participantIds: [alexId, bobId] } })
    expect(max.status).toBe(200)
    const zero = await post({ originalMinor: 0, payers: [{ participantId: alexId, minor: 0 }], split: { type: 'equal', participantIds: [alexId] } })
    expect(JSON.stringify(await zero.json())).toContain('Enter an amount greater than 0')
    const blank = await post({ originalMinor: 1000, payers: [{ participantId: alexId, minor: 1000 }], split: { type: 'exact', amounts: [{ participantId: alexId, minor: null }, { participantId: bobId, minor: null }] } })
    expect(blank.status).toBe(400)
    expect(JSON.stringify(await blank.json())).toContain('$10.00 left')
    const long = await post({ description: 'x'.repeat(81), originalMinor: 1000, payers: [{ participantId: alexId, minor: 1000 }], split: { type: 'equal', participantIds: [alexId] } })
    expect(long.status).toBe(400)
    expect(JSON.stringify(await long.json())).toContain('description of 80 characters')
  })
})
