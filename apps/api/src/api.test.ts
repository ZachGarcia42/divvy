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
})
