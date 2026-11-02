// Features working together: feed entries for foreign-currency expenses and for receipt photo changes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { groupOf, sessionFor } from './testkit.ts'

let dir = ''
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'divvy-merged-test-')); process.env.PHOTO_DIR = dir })
afterAll(() => { delete process.env.PHOTO_DIR; rmSync(dir, { recursive: true, force: true }) })

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(7)])

describe('feed + currencies + photos together', () => {
  it('a foreign-currency expense carries its original amount and currency on every feed entry kind', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'], undefined, { rateFor: async () => '1.1000' })
    const [you, maya] = ids as [string, string]
    const body = (minor: number) => ({ description: 'Lunch', date: '2026-10-20', originalCurrency: 'EUR', originalMinor: minor, payers: [{ participantId: you, minor: Math.round(minor * 1.1) }], split: { type: 'equal', participantIds: [you, maya] } })
    const id = (await call('POST', `/api/groups/${groupId}/expenses`, body(1000))).json.id as string
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, ...body(2000) })).status).toBe(200)
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 2 })).status).toBe(200)
    const items = (await call('GET', `/api/groups/${groupId}/feed`)).json.items as any[]
    expect(items.map((i) => i.kind)).toEqual(['expense.deleted', 'expense.updated', 'expense.created'])
    const [deleted, edited, created] = items
    expect(created).toMatchObject({ amountMinor: 1100, currency: 'USD', originalMinor: 1000, originalCurrency: 'EUR' })
    expect(edited).toMatchObject({ amountMinor: 2200, previousAmountMinor: 1100, originalMinor: 2000, originalCurrency: 'EUR' })
    expect(deleted).toMatchObject({ originalMinor: 2000, originalCurrency: 'EUR' })
  })

  it('a same-currency expense has no original amount on its feed entry', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    await call('POST', `/api/groups/${groupId}/expenses`, { description: 'Tacos', date: '2026-10-20', originalCurrency: 'USD', originalMinor: 1000, payers: [{ participantId: you, minor: 1000 }], split: { type: 'equal', participantIds: [you, maya] } })
    const [entry] = (await call('GET', `/api/groups/${groupId}/feed`)).json.items as any[]
    expect(entry).toMatchObject({ originalMinor: null, originalCurrency: null })
  })

  it('adding, replacing and removing a receipt photo each add a feed entry', async () => {
    const { app, call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const id = (await call('POST', `/api/groups/${groupId}/expenses`, { description: 'Dinner', date: '2026-10-20', originalCurrency: 'USD', originalMinor: 6000, payers: [{ participantId: you, minor: 6000 }], split: { type: 'equal', participantIds: [you, maya] } })).json.id as string
    const token = await sessionFor(app, 'alex@example.com')
    const path = `/api/groups/${groupId}/expenses/${id}/photo`
    const headers = { authorization: `Bearer ${token}`, 'x-divvy-platform': 'ios', 'content-type': 'image/jpeg' }
    expect((await app.request(path, { method: 'PUT', headers, body: JPEG as never })).status).toBe(200)
    expect((await app.request(path, { method: 'PUT', headers, body: JPEG as never })).status).toBe(200)
    expect((await app.request(path, { method: 'DELETE', headers })).status).toBe(200)
    const items = (await call('GET', `/api/groups/${groupId}/feed`)).json.items as any[]
    expect(items.map((i) => i.kind)).toEqual(['expense.photo_removed', 'expense.photo_replaced', 'expense.photo_added', 'expense.created'])
    expect(items[0]).toMatchObject({ amountMinor: 6000, target: { type: 'expense', id, label: 'Dinner', live: true }, actor: { name: 'Alex' } })
    // The all-groups feed has them too.
    expect(((await call('GET', '/api/feed')).json.items as any[]).length).toBe(4)
  })
})
