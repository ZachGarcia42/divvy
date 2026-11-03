import { describe, expect, it } from 'vitest'
import { groupOf, sessionFor } from './testkit.ts'

const base = { description: 'Dinner', date: '2026-10-20', originalCurrency: 'USD' }

async function setup(names: string[] = ['Maya']) {
  const ctx = await groupOf(names)
  const [you, maya] = ctx.ids as [string, string]
  const add = async (over: Record<string, unknown> = {}, groupId = ctx.groupId) => (await ctx.call('POST', `/api/groups/${groupId}/expenses`, {
    ...base, originalMinor: 4000, payers: [{ participantId: you, minor: Number(over.originalMinor ?? 4000) }], split: { type: 'equal', participantIds: maya ? [you, maya] : [you] }, ...over,
  })).json.id as string
  const feed = async (query = '', groupId: string | null = ctx.groupId) => {
    const res = await ctx.call('GET', `${groupId ? `/api/groups/${groupId}/feed` : '/api/feed'}${query}`)
    return { status: res.status, items: (res.json?.items ?? []) as any[], nextCursor: (res.json?.nextCursor ?? null) as string | null, json: res.json }
  }
  // A second group with the same two people, so expenses can move between them.
  const second = async (name = 'Other') => {
    const id = (await ctx.call('POST', '/api/groups', { name, currency: 'USD', timezone: 'UTC' })).json.group.id as string
    await ctx.sql.query(`insert into memberships (group_id, participant_id) values ($1,$2)`, [id, maya])
    return id
  }
  return { ...ctx, you, maya, add, feed, second }
}

describe('activity feed: what happened, who did it, how much', () => {
  it('lists adds, edits, deletes, restores, payments and undone payments newest first', async () => {
    const { call, groupId, you, maya, add, feed } = await setup()
    const id = await add({ originalMinor: 3500 })
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, originalMinor: 4000, payers: [{ participantId: you, minor: 4000 }] })).status).toBe(200)
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 2 })).status).toBe(200)
    expect((await call('POST', `/api/groups/${groupId}/expenses/${id}/restore`)).status).toBe(200)
    const pay = (await call('POST', `/api/groups/${groupId}/settlements`, { fromId: maya, toId: you, minor: 1000 })).json.id
    expect((await call('DELETE', `/api/groups/${groupId}/settlements/${pay}`)).status).toBe(200)

    const { status, items, nextCursor } = await feed()
    expect(status).toBe(200)
    expect(nextCursor).toBeNull()
    expect(items.map((item) => item.kind)).toEqual([
      'settlement.deleted', 'settlement.created', 'expense.restored', 'expense.deleted', 'expense.updated', 'expense.created',
    ])
    const times = items.map((item) => Date.parse(item.at))
    expect(times).toEqual([...times].sort((a, b) => b - a))

    const [undone, paid, restored, deleted, edited, created] = items
    expect(created).toMatchObject({ amountMinor: 3500, currency: 'USD', actor: { id: you, name: 'Alex' }, target: { type: 'expense', id, label: 'Dinner', live: true }, undo: false })
    expect(edited).toMatchObject({ amountMinor: 4000, previousAmountMinor: 3500 })
    expect(edited.changes.map((change: any) => change.field)).toContain('amount')
    expect(deleted).toMatchObject({ amountMinor: 4000, undo: false })
    expect(restored).toMatchObject({ amountMinor: 4000, undo: true, target: { live: true } })
    expect(paid).toMatchObject({ amountMinor: 1000, from: { id: maya, name: 'Maya' }, to: { id: you, name: 'Alex' }, target: { type: 'settlement', id: pay, live: false } })
    expect(undone).toMatchObject({ amountMinor: 1000, undo: true, from: { id: maya }, to: { id: you } })
    expect(created.group).toMatchObject({ id: groupId, name: 'Trip', currency: 'USD' })
    // No timestamps with more than milliseconds, no cursors on items.
    expect(created.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  })

  it('an edit that only changes the date keeps the amount and records no previous amount', async () => {
    const { call, groupId, add, feed } = await setup()
    const id = await add({ originalMinor: 2500 })
    await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, date: '2026-10-21' })
    const [edited] = (await feed()).items
    expect(edited).toMatchObject({ kind: 'expense.updated', amountMinor: 2500, previousAmountMinor: null })
    expect(edited.changes.map((change: any) => change.field)).toEqual(['date'])
  })

  it('carries the expense\'s own date, separate from when it was logged; payments have none', async () => {
    const { call, groupId, you, maya, add, feed } = await setup()
    const id = await add({ date: '2026-10-24' })
    await call('POST', `/api/groups/${groupId}/settlements`, { fromId: maya, toId: you, minor: 500 })
    const [paid, created] = (await feed()).items
    expect(created.expenseDate).toBe('2026-10-24')
    expect(Date.parse(created.at)).toBeGreaterThan(Date.parse('2026-10-25')) // logged now, dated earlier
    expect(paid.expenseDate).toBeNull()
    await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 1 })
    expect((await feed()).items[0].expenseDate).toBe('2026-10-24') // still known after a delete
  })

  it('later edits do not rewrite what an earlier entry says', async () => {
    const { call, groupId, you, add, feed } = await setup()
    const id = await add({ originalMinor: 1000, description: 'Taxi' })
    await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, originalMinor: 2000, payers: [{ participantId: you, minor: 2000 }], description: 'Cab' })
    await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 2, originalMinor: 3000, payers: [{ participantId: you, minor: 3000 }], description: 'Cab home' })
    const items = (await feed()).items
    expect(items.map((item) => [item.kind, item.amountMinor, item.target.label])).toEqual([
      ['expense.updated', 3000, 'Cab home'], ['expense.updated', 2000, 'Cab'], ['expense.created', 1000, 'Taxi'],
    ])
    expect(items[1].changes.map((change: any) => change.field).sort()).toEqual(['amount', 'description', 'split'])
  })

  it('names the person who did it when it is someone else', async () => {
    const ctx = await setup()
    const invite = await ctx.call('POST', `/api/groups/${ctx.groupId}/invite-link`)
    const token = await sessionFor(ctx.app, 'jordan@example.com')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const accepted = await ctx.app.request(`/api/invites/${invite.json.token}/accept`, { method: 'POST', headers })
    expect(accepted.status).toBe(200)
    const id = await ctx.add({ originalMinor: 1200 })
    const edit = await ctx.app.request(`/api/groups/${ctx.groupId}/expenses/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ version: 1, description: 'Pizza' }) })
    expect(edit.status).toBe(200)
    const items = (await ctx.feed()).items
    expect(items[0]).toMatchObject({ kind: 'expense.updated', actor: { name: 'Jordan' }, target: { label: 'Pizza' }, amountMinor: 1200 })
    expect(items[1].actor.name).toBe('Alex')
    // Jordan sees the same group feed.
    const theirs = await ctx.app.request(`/api/groups/${ctx.groupId}/feed`, { headers })
    expect(((await theirs.json()) as any).items).toHaveLength(2)
  })

  it('only expense and payment events appear, not group admin events', async () => {
    const { groupId, add, feed, sql } = await setup()
    await add()
    const raw = await sql.query<{ kind: string }>(`select kind from activity where group_id = $1`, [groupId])
    expect(raw.some((row) => row.kind === 'member.added')).toBe(true)
    const kinds = (await feed()).items.map((item) => item.kind)
    expect(kinds).toEqual(['expense.created'])
  })

  it('leaves no ghost entries for undoing something that is not there', async () => {
    const { call, groupId, add, feed, you, maya } = await setup()
    const id = await add()
    expect((await call('POST', `/api/groups/${groupId}/expenses/${id}/restore`)).status).toBe(200) // not deleted
    expect((await call('DELETE', `/api/groups/${groupId}/settlements/nope`)).status).toBe(200)
    expect((await call('POST', `/api/groups/${groupId}/settlements/nope/restore`)).status).toBe(200)
    const pay = (await call('POST', `/api/groups/${groupId}/settlements`, { fromId: you, toId: maya, minor: 500 })).json.id
    await call('POST', `/api/groups/${groupId}/settlements/${pay}/restore`) // not undone
    await call('DELETE', `/api/groups/${groupId}/settlements/${pay}`)
    await call('DELETE', `/api/groups/${groupId}/settlements/${pay}`) // twice
    expect((await feed()).items.map((item) => item.kind)).toEqual(['settlement.deleted', 'settlement.created', 'expense.created'])
  })

  it('moves show in both groups with their direction', async () => {
    const { call, groupId, add, feed, second } = await setup()
    const other = await second('Roommates')
    const id = await add({ originalMinor: 900 })
    expect((await call('POST', `/api/groups/${groupId}/expenses/${id}/move`, { destinationGroupId: other })).status).toBe(200)
    const out = (await feed()).items[0]
    expect(out).toMatchObject({ kind: 'expense.moved', direction: 'out', amountMinor: 900, group: { id: groupId } })
    const into = (await feed('', other)).items[0]
    expect(into).toMatchObject({ kind: 'expense.moved', direction: 'in', amountMinor: 900, target: { label: 'Dinner', live: true }, group: { id: other, name: 'Roommates' } })
  })

  it('a moved payment keeps its amount and people', async () => {
    const { call, you, maya, feed, second, groupId } = await setup()
    const other = await second()
    const pay = (await call('POST', `/api/groups/${groupId}/settlements`, { fromId: maya, toId: you, minor: 700 })).json.id
    expect((await call('POST', `/api/groups/${groupId}/settlements/${pay}/move`, { destinationGroupId: other })).status).toBe(200)
    expect((await feed()).items[0]).toMatchObject({ kind: 'settlement.moved', direction: 'out', amountMinor: 700 })
    expect((await feed('', other)).items[0]).toMatchObject({ kind: 'settlement.moved', direction: 'in', amountMinor: 700, from: { id: maya, name: 'Maya' }, to: { id: you }, target: { live: true }, group: { id: other } })
  })

  it('a move that is refused logs nothing', async () => {
    const { call, groupId, add, feed } = await setup()
    const lonely = (await call('POST', '/api/groups', { name: 'Solo', currency: 'USD', timezone: 'UTC' })).json.group.id
    const id = await add()
    expect((await call('POST', `/api/groups/${groupId}/expenses/${id}/move`, { destinationGroupId: lonely })).status).toBe(400)
    expect((await feed()).items.map((item) => item.kind)).toEqual(['expense.created'])
    expect((await feed('', lonely)).items).toEqual([])
  })
})

describe('activity feed: paging', () => {
  it('pages newest first with no gaps or repeats, and ends with a null cursor', async () => {
    const { add, feed } = await setup()
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push(await add({ originalMinor: 100 + i, description: `Item ${i}` }))
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await feed(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(page.status).toBe(200)
      expect(page.items.length).toBeLessThanOrEqual(3)
      seen.push(...page.items.map((item) => item.target.label))
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(seen).toEqual(['Item 6', 'Item 5', 'Item 4', 'Item 3', 'Item 2', 'Item 1', 'Item 0'])
  })

  it('an exact multiple of the page size ends cleanly (no empty extra page promised)', async () => {
    const { add, feed } = await setup()
    await add(); await add()
    const first = await feed('?limit=2')
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeNull()
  })

  it('new activity arriving between pages does not shift or repeat what comes next', async () => {
    const { add, feed } = await setup()
    for (let i = 0; i < 4; i++) await add({ description: `Old ${i}` })
    const first = await feed('?limit=2')
    expect(first.items.map((item) => item.target.label)).toEqual(['Old 3', 'Old 2'])
    await add({ description: 'Brand new' })
    const second = await feed(`?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.items.map((item) => item.target.label)).toEqual(['Old 1', 'Old 0'])
    expect((await feed('?limit=1')).items[0].target.label).toBe('Brand new')
  })

  it('rows with exactly the same timestamp page by id, losing none', async () => {
    const { groupId, sql, feed, you } = await setup()
    const at = '2026-10-01T12:00:00.123456Z'
    for (const id of ['t-a', 't-b', 't-c', 't-d', 't-e']) {
      await sql.query(`insert into activity (id, group_id, actor_participant_id, kind, summary, payload, created_at) values ($1,$2,$3,'expense.created','x',$4,$5)`, [id, groupId, you, JSON.stringify({ expenseId: id }), at])
    }
    const labels: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 10; i++) {
      const page = await feed(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      labels.push(...page.items.map((item) => item.target.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(labels).toEqual(['t-e', 't-d', 't-c', 't-b', 't-a'])
  })

  it('microsecond differences are respected across pages', async () => {
    const { groupId, sql, feed, you } = await setup()
    const rows = [['m-1', '2026-10-01T12:00:00.100001Z'], ['m-2', '2026-10-01T12:00:00.100002Z'], ['m-3', '2026-10-01T12:00:00.100003Z']]
    for (const [id, at] of rows) {
      await sql.query(`insert into activity (id, group_id, actor_participant_id, kind, summary, payload, created_at) values ($1,$2,$3,'expense.created','x','{}',$4)`, [id, groupId, you, at])
    }
    const one = await feed('?limit=1')
    const two = await feed(`?limit=1&cursor=${encodeURIComponent(one.nextCursor!)}`)
    const three = await feed(`?limit=1&cursor=${encodeURIComponent(two.nextCursor!)}`)
    expect([one, two, three].map((page) => page.items[0]!.id)).toEqual(['m-3', 'm-2', 'm-1'])
    expect(three.nextCursor).toBeNull()
  })

  it('limit is clamped and a bad cursor is a clean 400', async () => {
    const { add, feed } = await setup()
    await add()
    expect((await feed('?limit=0')).items).toHaveLength(1)
    expect((await feed('?limit=abc')).items).toHaveLength(1)
    expect((await feed('?limit=100000')).status).toBe(200)
    const bad = await feed('?cursor=garbage')
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('BAD_CURSOR')
    expect((await feed(`?cursor=${encodeURIComponent("2026-10-01T12:00:00.123456Z|x';select 1")}`)).status).toBe(400)
  })
})

describe('activity feed: who can see what', () => {
  it('needs a sign-in', async () => {
    const { app, groupId } = await setup()
    expect((await app.request(`/api/groups/${groupId}/feed`)).status).toBe(401)
    expect((await app.request('/api/feed')).status).toBe(401)
  })

  it('a group feed is for members only, and an unknown group is 404', async () => {
    const { app, groupId, add, call } = await setup()
    await add()
    const token = await sessionFor(app, 'stranger@example.com')
    const res = await app.request(`/api/groups/${groupId}/feed`, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('Dinner')
    expect((await call('GET', '/api/groups/nope/feed')).status).toBe(404)
  })

  it('the global feed spans my groups, labels each by group, and never includes anyone else\'s', async () => {
    const { app, add, feed, second } = await setup()
    const other = await second('Roommates')
    await add({ description: 'Tahoe gas' })
    await add({ description: 'Rent' }, other)
    await add({ description: 'More gas' })
    const all = await feed('', null)
    expect(all.items.map((item) => [item.target.label, item.group.name])).toEqual([['More gas', 'Trip'], ['Rent', 'Roommates'], ['Tahoe gas', 'Trip']])

    // A stranger with their own group sees only their own.
    const token = await sessionFor(app, 'stranger@example.com')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const made = await app.request('/api/groups', { method: 'POST', headers, body: JSON.stringify({ name: 'Theirs', currency: 'USD', timezone: 'UTC' }) })
    const theirs = ((await made.json()) as any).group.id
    const send = async (path: string, body: unknown) => ((await (await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })).json()) as any)
    const mine = ((await (await app.request(`/api/groups/${theirs}`, { headers })).json()) as any).members[0].id as string
    const friend = (await send(`/api/groups/${theirs}/people`, { displayName: 'Pat' })).participantId as string
    const res = await app.request(`/api/groups/${theirs}/expenses`, { method: 'POST', headers, body: JSON.stringify({ ...base, description: 'Secret', originalMinor: 100, payers: [{ participantId: mine, minor: 100 }], split: { type: 'equal', participantIds: [mine, friend] } }) })
    expect(res.status).toBe(200)
    const strangerFeed = (await (await app.request('/api/feed', { headers })).json()) as any
    expect(strangerFeed.items.map((item: any) => item.target.label)).toEqual(['Secret'])
    expect((await feed('', null)).items.some((item) => item.target.label === 'Secret')).toBe(false)
  })

  it('/api/feed?groupId= is one group\'s feed: the same page as the group route, members only', async () => {
    const { app, groupId, add, feed, second, call } = await setup()
    const other = await second('Roommates')
    await add({ description: 'Tahoe gas' })
    await add({ description: 'Rent' }, other)
    await add({ description: 'More gas' })
    const narrowed = await feed(`?groupId=${other}`, null)
    expect(narrowed.status).toBe(200)
    expect(narrowed.items.map((item) => [item.target.label, item.group.id])).toEqual([['Rent', other]])
    expect((await feed('', other)).items).toEqual(narrowed.items)
    expect((await feed(`?groupId=${groupId}`, null)).items.map((item) => item.target.label)).toEqual(['More gas', 'Tahoe gas'])
    // It pages like the others, and an empty groupId is the all-groups feed.
    const first = await feed(`?groupId=${groupId}&limit=1`, null)
    expect(first.items.map((item) => item.target.label)).toEqual(['More gas'])
    const next = await feed(`?groupId=${groupId}&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`, null)
    expect(next.items.map((item) => item.target.label)).toEqual(['Tahoe gas'])
    expect((await feed('?groupId=', null)).items).toHaveLength(3)
    // Someone outside the group cannot read it that way either; an unknown group is 404.
    const token = await sessionFor(app, 'stranger@example.com')
    const res = await app.request(`/api/feed?groupId=${groupId}`, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('Tahoe gas')
    expect((await call('GET', '/api/feed?groupId=nope')).status).toBe(404)
  })

  it('a member who has left stops seeing that group in their global feed', async () => {
    const ctx = await setup()
    const invite = await ctx.call('POST', `/api/groups/${ctx.groupId}/invite-link`)
    const token = await sessionFor(ctx.app, 'jordan@example.com')
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const accepted = (await (await ctx.app.request(`/api/invites/${invite.json.token}/accept`, { method: 'POST', headers })).json()) as any
    await ctx.add({ description: 'Visible' })
    const before = (await (await ctx.app.request('/api/feed', { headers })).json()) as any
    expect(before.items.map((item: any) => item.target.label)).toEqual(['Visible'])
    const jordan = accepted.members.find((member: any) => member.name === 'jordan' || member.email === 'jordan@example.com')
    await ctx.sql.query(`update memberships set removed_at = now() where group_id = $1 and participant_id = $2`, [ctx.groupId, jordan.id])
    const after = (await (await ctx.app.request('/api/feed', { headers })).json()) as any
    expect(after.items).toEqual([])
    expect((await ctx.app.request(`/api/groups/${ctx.groupId}/feed`, { headers })).status).toBe(403)
  })
})

describe('activity feed: rows written before this feature', () => {
  it('older rows still render, from what the app knew then', async () => {
    const { groupId, sql, feed, you, maya, add, call } = await setup()
    const id = await add({ originalMinor: 4200, description: 'Groceries' })
    const pay = (await call('POST', `/api/groups/${groupId}/settlements`, { fromId: maya, toId: you, minor: 1500 })).json.id
    await sql.query(`delete from activity where group_id = $1`, [groupId])
    await sql.query(`delete from expense_history`)
    const put = (aid: string, kind: string, payload: unknown, at: string) =>
      sql.query(`insert into activity (id, group_id, actor_participant_id, kind, summary, payload, created_at) values ($1,$2,$3,$4,'old',$5,$6)`, [aid, groupId, you, kind, JSON.stringify(payload), at])
    // Exactly what the previous version wrote.
    await put('l1', 'expense.created', { expenseId: id, settlementMinor: 4200 }, '2026-10-01T10:00:00Z')
    await put('l2', 'expense.updated', { expenseId: id, previous: { settlementMinor: 4200, description: 'Groceries' } }, '2026-10-01T11:00:00Z')
    await put('l3', 'settlement.created', { settlementId: pay, minor: 1500 }, '2026-10-01T12:00:00Z')
    await put('l4', 'settlement.deleted', { settlementId: pay }, '2026-10-01T13:00:00Z')
    await put('l5', 'expense.moved', { expenseId: id }, '2026-10-01T14:00:00Z')
    await sql.query(`update activity set summary = 'Alex moved “Groceries” out' where id = 'l5'`)
    await put('l6', 'expense.restored', { expenseId: id }, '2026-10-01T15:00:00Z')
    await put('l7', 'expense.created', { expenseId: 'deleted-for-good' }, '2026-10-01T16:00:00Z')
    await put('l8', 'settlement.restored', { settlementId: 'vanished' }, '2026-10-01T17:00:00Z')
    await sql.query(`insert into activity (id, group_id, actor_participant_id, kind, summary, payload, created_at) values ('l9', $1, null, 'expense.deleted', 'x', 'not json', '2026-10-01T18:00:00Z')`, [groupId])

    const { status, items } = await feed()
    expect(status).toBe(200)
    const byId = Object.fromEntries(items.map((item) => [item.id, item]))
    expect(byId.l1).toMatchObject({ amountMinor: 4200, target: { label: 'Groceries' } })
    expect(byId.l2).toMatchObject({ kind: 'expense.updated', amountMinor: 4200, changes: null })
    expect(byId.l3).toMatchObject({ amountMinor: 1500, from: { id: maya, name: 'Maya' }, to: { id: you, name: 'Alex' } })
    expect(byId.l4).toMatchObject({ undo: true, amountMinor: 1500, from: { id: maya } })
    expect(byId.l5).toMatchObject({ direction: 'out', amountMinor: 4200 })
    expect(byId.l6).toMatchObject({ undo: true, amountMinor: 4200 })
    expect(byId.l7).toMatchObject({ amountMinor: null, target: { label: '', live: false } })
    expect(byId.l8).toMatchObject({ amountMinor: null, from: { id: null }, to: { id: null } })
    expect(byId.l9).toMatchObject({ kind: 'expense.deleted', actor: { id: null, name: null }, amountMinor: null })
    expect(items).toHaveLength(9)
    expect(Date.parse(items[0].at)).toBeGreaterThanOrEqual(Date.parse(items[items.length - 1].at))
  })

  it('the old per-group activity endpoint is unchanged', async () => {
    const { call, groupId, add } = await setup()
    await add()
    const res = await call('GET', `/api/groups/${groupId}/activity`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.json)).toBe(true)
    expect(Object.keys(res.json[0]).sort()).toEqual(['createdAt', 'id', 'kind', 'payload', 'summary'])
  })
})
