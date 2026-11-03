import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatMoney } from '@divvy/domain'
import { groupOf, sessionFor } from './testkit.ts'

// Fixes from QA's report on next-all 2254175 (FD-08, RG-10, FX-20 and the smaller notes).
let dir = ''
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'divvy-qafix-test-')); process.env.PHOTO_DIR = dir })
afterAll(() => { delete process.env.PHOTO_DIR; rmSync(dir, { recursive: true, force: true }) })

const base = { description: 'Dinner', date: '2026-10-20', originalCurrency: 'USD' }

async function setup() {
  const ctx = await groupOf(['Maya'])
  const [you, maya] = ctx.ids as [string, string]
  const body = { ...base, originalMinor: 4000, payers: [{ participantId: you, minor: 4000 }], split: { type: 'equal', participantIds: [you, maya] } }
  const id = (await ctx.call('POST', `/api/groups/${ctx.groupId}/expenses`, body)).json.id as string
  const counts = async () => {
    const one = async (q: string) => Number(((await ctx.sql.query<{ n: string }>(q, [id]))[0]!).n)
    return {
      activity: Number(((await ctx.sql.query<{ n: string }>(`select count(*) as n from activity where group_id = $1`, [ctx.groupId]))[0]!).n),
      history: await one(`select count(*) as n from expense_history where expense_id = $1`),
      notifications: Number(((await ctx.sql.query<{ n: string }>(`select count(*) as n from notifications`))[0]!).n),
      version: Number(((await ctx.sql.query<{ n: string }>(`select version as n from expenses where id = $1`, [id]))[0]!).n),
    }
  }
  return { ...ctx, you, maya, body, id, counts }
}

describe('FD-08: deleting an expense that is already deleted', () => {
  it('is refused (409) and leaves the version, feed, history and notifications alone', async () => {
    const t = await setup()
    expect((await t.call('DELETE', `/api/groups/${t.groupId}/expenses/${t.id}`, { version: 1 })).status).toBe(200)
    const after = await t.counts()
    expect(after.version).toBe(2)
    for (const version of [2, 1, 3]) {
      const again = await t.call('DELETE', `/api/groups/${t.groupId}/expenses/${t.id}`, { version })
      expect(again.status).toBe(409)
      expect(again.json.error.code).toBe('STALE')
    }
    expect((await t.call('DELETE', `/api/groups/${t.groupId}/expenses/${t.id}?version=2`)).status).toBe(409)
    expect(await t.counts()).toEqual(after)
    const feed = (await t.call('GET', `/api/groups/${t.groupId}/feed`)).json.items as { kind: string }[]
    expect(feed.filter((item) => item.kind === 'expense.deleted')).toHaveLength(1)
  })
  it('still deletes a live expense, and restore then delete works again', async () => {
    const t = await setup()
    expect((await t.call('DELETE', `/api/groups/${t.groupId}/expenses/${t.id}`, { version: 1 })).status).toBe(200)
    expect((await t.call('POST', `/api/groups/${t.groupId}/expenses/${t.id}/restore`)).status).toBe(200)
    expect((await t.call('DELETE', `/api/groups/${t.groupId}/expenses/${t.id}`, { version: 3 })).status).toBe(200)
  })
})

describe('RG-10: a body that is not JSON', () => {
  it('answers 400 BAD_JSON on every route that reads one, not 500', async () => {
    const t = await setup()
    const session = await sessionFor(t.app, 'alex@example.com')
    const raw = (method: string, path: string, body: string) => t.app.request(path, { method, headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json', 'x-divvy-platform': 'ios' }, body })
    for (const [method, path] of [
      ['POST', `/api/groups/${t.groupId}/expenses`], ['PATCH', `/api/groups/${t.groupId}/expenses/${t.id}`], ['POST', '/api/groups'],
      ['PATCH', `/api/groups/${t.groupId}`], ['POST', `/api/groups/${t.groupId}/settlements`], ['POST', `/api/groups/${t.groupId}/defaults`],
    ] as const) {
      for (const body of ['{"description": "x"', 'not json', '{']) {
        const res = await raw(method, path, body)
        expect(res.status, `${method} ${path} ${body}`).toBe(400)
        expect((await res.json() as any).error.code).toBe('BAD_JSON')
      }
    }
  })
})

describe('FX-20: originalCurrency that is not text', () => {
  it('is a 400 BAD_CURRENCY, on create and on edit', async () => {
    const t = await setup()
    for (const bad of [1, ['EUR'], { a: 1 }, true, 0]) {
      const created = await t.call('POST', `/api/groups/${t.groupId}/expenses`, { ...t.body, originalCurrency: bad })
      expect(created.status, JSON.stringify(bad)).toBe(400)
      expect(created.json.error.code).toBe('BAD_CURRENCY')
      const edited = await t.call('PATCH', `/api/groups/${t.groupId}/expenses/${t.id}`, { version: 1, originalCurrency: bad })
      expect(edited.status, JSON.stringify(bad)).toBe(400)
      expect(edited.json.error.code).toBe('BAD_CURRENCY')
    }
    expect((await t.call('POST', `/api/groups/${t.groupId}/expenses`, { ...t.body, originalCurrency: 'eur ' })).status).toBe(400)
    expect((await t.call('POST', `/api/groups/${t.groupId}/expenses`, { ...t.body, originalCurrency: null })).status).toBe(200)
  })
})

describe('smaller notes', () => {
  it('defaults and blocks with a wrong-shaped body are 400', async () => {
    const t = await setup()
    for (const body of [{}, { weights: 'x' }, { weights: [1] }, { weights: [null] }, { weights: [{ weight: 1 }] }, { weights: [{ participantId: 5, weight: 1 }] }, null, []]) {
      const res = await t.call('POST', `/api/groups/${t.groupId}/defaults`, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect((await t.call('POST', `/api/groups/${t.groupId}/defaults`, { weights: [{ participantId: t.maya, weight: 2 }] })).status).toBe(200)
    for (const body of [{}, { userId: 5 }, { userId: '' }, { userId: ['a'] }, null]) {
      expect((await t.call('POST', '/api/blocks', body)).status, JSON.stringify(body)).toBe(400)
    }
  })
  it('a group can only be created or changed to a currency the app offers', async () => {
    const t = await setup()
    for (const currency of ['ZZZ', 'XXX', 'AB', '', 'E1R']) {
      const res = await t.call('POST', '/api/groups', { name: 'Odd', currency, timezone: 'UTC' })
      expect(res.status, currency).toBe(400)
      expect(res.json.error.code).toBe('BAD_CURRENCY')
    }
    expect((await t.call('POST', '/api/groups', { name: 'Euro', currency: 'eur', timezone: 'UTC' })).status).toBe(200)
    const empty = await t.call('POST', '/api/groups', { name: 'Fresh', currency: 'USD', timezone: 'UTC' })
    const fresh = empty.json.group.id as string
    expect((await t.call('PATCH', `/api/groups/${fresh}`, { currency: '' })).status).toBe(400)
    expect((await t.call('PATCH', `/api/groups/${fresh}`, { currency: 'ZZZ' })).status).toBe(400)
    expect((await t.call('PATCH', `/api/groups/${fresh}`, { currency: 'GBP' })).status).toBe(200)
  })
  it('a currency with no symbol of its own reads with a space: KWD 12.345', () => {
    expect(formatMoney(12345, 'KWD')).toBe('KWD 12.345')
    expect(formatMoney(-12345, 'KWD')).toBe('-KWD 12.345')
    expect(formatMoney(1200, 'USD')).toBe('$12.00')
    expect(formatMoney(1200, 'EUR')).toBe('€12.00')
  })
  it('a deleted expense has no photo for anyone, and has it back once restored', async () => {
    const t = await setup()
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
    const photoPath = `/api/groups/${t.groupId}/expenses/${t.id}/photo`
    const session = await sessionFor(t.app, 'alex@example.com')
    const headers = { authorization: `Bearer ${session}`, 'content-type': 'image/jpeg', 'x-divvy-platform': 'ios' }
    expect((await t.app.request(photoPath, { method: 'PUT', headers, body: JPEG as never })).status).toBe(200)
    expect((await t.app.request(photoPath, { headers })).status).toBe(200)
    const version = (await t.call('GET', `/api/groups/${t.groupId}/expenses/${t.id}`)).json.expense.version as number
    expect((await t.call('DELETE', `/api/groups/${t.groupId}/expenses/${t.id}`, { version })).status).toBe(200)
    expect((await t.app.request(photoPath, { headers })).status).toBe(404)
    await t.call('POST', `/api/groups/${t.groupId}/expenses/${t.id}/restore`)
    expect((await t.app.request(photoPath, { headers })).status).toBe(200)
  })
})
