import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createMemorySql } from './db.ts'
import { sessionFor } from './testkit.ts'

async function twoPeople() {
  const sql = await createMemorySql()
  const { app } = createApp(sql, { now: () => new Date('2026-10-27T15:00:00Z'), dev: true, rateFor: async () => '1' })
  const as = (token: string) => async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-divvy-platform': 'ios' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  const alex = as(await sessionFor(app, 'alex@example.com'))
  const maya = as(await sessionFor(app, 'maya@example.com'))
  const outsider = as(await sessionFor(app, 'zed@example.com'))
  const created = (await alex('POST', '/api/groups', { name: 'Trip', currency: 'USD', timezone: 'UTC' })).json
  const groupId = created.group.id as string
  const link = (await alex('POST', `/api/groups/${groupId}/invite-link`)).json as { token: string }
  expect((await maya('POST', `/api/invites/${link.token}/accept`)).status).toBe(200)
  return { sql, app, alex, maya, outsider, groupId }
}

describe('payment names', () => {
  it('saves, normalizes and returns your own handles', async () => {
    const { maya } = await twoPeople()
    const saved = await maya('PATCH', '/api/me', { pay: { venmo: '@maya-rios', paypal: 'https://paypal.me/mayarios', cashapp: '$mayarios' } })
    expect(saved.status).toBe(200)
    expect(saved.json.pay).toEqual({ venmo: 'maya-rios', paypal: 'mayarios', cashapp: 'mayarios' })
    expect((await maya('GET', '/api/home')).json.you.pay).toEqual({ venmo: 'maya-rios', paypal: 'mayarios', cashapp: 'mayarios' })
  })

  it('changes only what is sent, and clears with null or empty text', async () => {
    const { maya } = await twoPeople()
    await maya('PATCH', '/api/me', { pay: { venmo: 'maya-rios', paypal: 'mayarios' } })
    await maya('PATCH', '/api/me', { pay: { venmo: 'maya-rios2' } })
    expect((await maya('GET', '/api/home')).json.you.pay).toEqual({ venmo: 'maya-rios2', paypal: 'mayarios' })
    expect((await maya('PATCH', '/api/me', { pay: { paypal: null } })).json.pay).toEqual({ venmo: 'maya-rios2' })
    expect((await maya('PATCH', '/api/me', { pay: { venmo: '  ' } })).json.pay).toEqual({})
  })

  it('rejects bad handles, unknown apps and bad shapes, and a bad one changes nothing', async () => {
    const { maya } = await twoPeople()
    await maya('PATCH', '/api/me', { pay: { venmo: 'maya-rios' } })
    for (const pay of [{ venmo: 'abc' }, { venmo: 'has space' }, { paypal: 'a_b' }, { cashapp: '1234' }, { zelle: 'maya' }, { venmo: 5 }, 'venmo', ['venmo'], { venmo: 'valid-name', cashapp: 'bad name' }]) {
      const res = await maya('PATCH', '/api/me', { pay })
      expect(res.status, JSON.stringify(pay)).toBe(400)
      expect(res.json.error.code).toBe('BAD_HANDLE')
    }
    expect((await maya('GET', '/api/home')).json.you.pay).toEqual({ venmo: 'maya-rios' })
  })

  it('needs a signed-in account', async () => {
    const { app } = await twoPeople()
    const res = await app.request('/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pay: { venmo: 'maya-rios' } }) })
    expect(res.status).toBe(401)
  })

  it('shows handles to people in the group, never to anyone else', async () => {
    const { alex, maya, outsider, groupId } = await twoPeople()
    await maya('PATCH', '/api/me', { pay: { venmo: 'maya-rios', cashapp: '$mayarios' } })
    const seen = (await alex('GET', `/api/groups/${groupId}`)).json.members as { name: string; pay?: unknown }[]
    expect(seen.find((m) => m.name === 'Maya')?.pay).toEqual({ venmo: 'maya-rios', cashapp: 'mayarios' })
    expect(seen.find((m) => m.name === 'Alex')?.pay).toBeUndefined()
    const blocked = await outsider('GET', `/api/groups/${groupId}`)
    expect([401, 403, 404]).toContain(blocked.status)
    expect(JSON.stringify(blocked.json)).not.toContain('maya-rios')
    // Someone not in the group can see none of it, including through an invite preview of another group.
    const outsiderGroups = (await outsider('GET', '/api/home')).json
    expect(JSON.stringify(outsiderGroups)).not.toContain('maya-rios')
  })

  it('stops sharing a member’s handles once they are removed from the group', async () => {
    const { alex, maya, groupId } = await twoPeople()
    await maya('PATCH', '/api/me', { pay: { venmo: 'maya-rios' } })
    const mayaId = ((await alex('GET', `/api/groups/${groupId}`)).json.members as { id: string; name: string }[]).find((m) => m.name === 'Maya')!.id
    const removed = await alex('POST', `/api/groups/${groupId}/members/${mayaId}/remove`)
    expect(removed.status).toBe(200)
    const after = ((await alex('GET', `/api/groups/${groupId}`)).json.members as { name: string; removed: boolean; pay?: unknown }[]).find((m) => m.name === 'Maya')!
    expect(after.removed).toBe(true)
    expect(after.pay).toBeUndefined()
  })

  it('leaves people who never typed a payment name alone', async () => {
    const { alex, groupId } = await twoPeople()
    const members = (await alex('GET', `/api/groups/${groupId}`)).json.members as { pay?: unknown }[]
    expect(members.every((m) => m.pay === undefined)).toBe(true)
    expect((await alex('GET', '/api/home')).json.you.pay).toEqual({})
  })

  it('still updates the name and currency without touching handles', async () => {
    const { maya } = await twoPeople()
    await maya('PATCH', '/api/me', { pay: { venmo: 'maya-rios' } })
    const res = await maya('PATCH', '/api/me', { displayName: 'Maya R' })
    expect(res.json).toMatchObject({ displayName: 'Maya R', pay: { venmo: 'maya-rios' } })
  })
})

describe('payment names migration', () => {
  it('only adds three nullable columns to users, keeps every existing row, and is safe to run twice', async () => {
    const { PGlite } = await import('@electric-sql/pglite')
    const full = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    const marker = full.indexOf('-- Payment links:')
    expect(marker).toBeGreaterThan(0)
    expect(full.slice(marker)).not.toMatch(/drop |delete |update |alter table (?!users add column if not exists)/i)
    const db = new PGlite()
    await db.exec(full.slice(0, marker))
    await db.query(`insert into users (id, email, display_name) values ('u1', 'old@example.com', 'Old Timer')`)
    const before = (await db.query(`select * from users`)).rows
    await db.exec(full)
    await db.exec(full)
    const after = (await db.query<Record<string, unknown>>(`select * from users`)).rows
    expect(after).toHaveLength(1)
    const { venmo_handle, paypal_handle, cashapp_handle, ...kept } = after[0]!
    expect([venmo_handle, paypal_handle, cashapp_handle]).toEqual([null, null, null])
    expect(kept).toEqual(before[0])
  })
})
