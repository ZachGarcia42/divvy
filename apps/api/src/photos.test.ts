import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LedgerError } from '@divvy/domain'
import { checkPhoto, createPhotoStore, defaultPhotoDir, PHOTO_MAX_BYTES, sniffImage } from './photos.ts'
import { groupOf, sessionFor } from './testkit.ts'

const bytesOf = (...head: number[]) => Uint8Array.from([...head, ...new Array(64).fill(7)])
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0)
const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const WEBP = bytesOf(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP'))
const HEIC = bytesOf(0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('heic'))
const GIF = bytesOf(...ascii('GIF89a'))

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'divvy-photos-test-'))
  process.env.PHOTO_DIR = dir
})
afterAll(() => {
  delete process.env.PHOTO_DIR
  rmSync(dir, { recursive: true, force: true })
})

const base = { description: 'Dinner', date: '2026-10-20', originalCurrency: 'USD' }

async function setup() {
  const ctx = await groupOf(['Maya'])
  const [you, maya] = ctx.ids as [string, string]
  const created = await ctx.call('POST', `/api/groups/${ctx.groupId}/expenses`, {
    ...base, originalMinor: 6000, payers: [{ participantId: you, minor: 6000 }], split: { type: 'equal', participantIds: [you, maya] },
  })
  const expenseId = created.json.id as string
  const path = `/api/groups/${ctx.groupId}/expenses/${expenseId}/photo`
  const token = await sessionFor(ctx.app, 'alex@example.com')
  const headersFor = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, 'x-divvy-platform': 'ios', ...extra })
  const put = (body: Uint8Array | string, t = token, type = 'image/jpeg') =>
    ctx.app.request(path, { method: 'PUT', headers: headersFor(t, { 'content-type': type }), body: body as never })
  const get = (t: string | null = token) => ctx.app.request(path, { headers: t ? headersFor(t) : {} })
  const del = (t = token) => ctx.app.request(path, { method: 'DELETE', headers: headersFor(t) })
  const detail = async () => (await ctx.call('GET', `/api/groups/${ctx.groupId}/expenses/${expenseId}`)).json
  return { ...ctx, expenseId, path, token, put, get, del, detail, headersFor }
}

const filesOnDisk = () => readdirSync(dir).filter((f) => !f.endsWith('.tmp'))

describe('photo format checks (magic bytes)', () => {
  it('recognises jpeg, png and webp whatever the file is called', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg')
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(WEBP)).toBe('image/webp')
    expect(checkPhoto(JPEG)).toBe('image/jpeg')
  })

  it('refuses heic with a clear message, and everything else that is not an image', () => {
    expect(sniffImage(HEIC)).toBe('heic')
    expect(() => checkPhoto(HEIC)).toThrow(/HEIC/)
    try { checkPhoto(HEIC) } catch (e) { expect((e as LedgerError).code).toBe('PHOTO_HEIC') }
    for (const bad of [GIF, bytesOf(...ascii('%PDF-1.7')), bytesOf(...ascii('<svg xmlns=')), bytesOf(...ascii('<html>')), bytesOf(0xff, 0xd8)]) {
      expect(() => checkPhoto(bad)).toThrow(/Only JPEG, PNG and WebP/)
    }
    expect(() => checkPhoto(new Uint8Array(0))).toThrow(/empty/)
  })

  it('caps the size at 5 MB: exactly 5 MB passes, one byte more does not', () => {
    const exact = new Uint8Array(PHOTO_MAX_BYTES); exact.set(JPEG)
    expect(checkPhoto(exact)).toBe('image/jpeg')
    const over = new Uint8Array(PHOTO_MAX_BYTES + 1); over.set(JPEG)
    expect(() => checkPhoto(over)).toThrow(/5 MB/)
  })

  it('the store only accepts random 32-hex ids, so a name can never reach outside its folder', async () => {
    const store = createPhotoStore(join(dir, 'unit'))
    await expect(store.put('../escape', JPEG)).rejects.toThrow(/bad photo id/)
    expect(await store.get('..')).toBeNull()
    await store.put('a'.repeat(32), JPEG)
    expect(await store.get('a'.repeat(32))).toEqual(Buffer.from(JPEG))
    await store.remove('a'.repeat(32))
    expect(await store.get('a'.repeat(32))).toBeNull()
  })

  it('defaults to <data>/photos next to the database; PHOTO_DIR overrides', () => {
    expect(defaultPhotoDir({})).toMatch(/data\/photos$/)
    expect(defaultPhotoDir({ PHOTO_DIR: '/srv/receipts' })).toBe('/srv/receipts')
  })
})

describe('receipt photo API', () => {
  it('adds, serves back identical bytes, replaces and removes; one file on disk at a time, random names', async () => {
    const t = await setup()
    expect((await t.detail()).photo).toBeNull()
    expect((await t.get()).status).toBe(404)

    const first = await t.put(JPEG)
    expect(first.status).toBe(200)
    const info = (await first.json()).photo
    expect(info).toMatchObject({ contentType: 'image/jpeg', bytes: JPEG.length, byName: 'Alex', byId: t.ids[0] })
    expect(info.id).toMatch(/^[a-f0-9]{32}$/)
    expect(filesOnDisk()).toEqual(expect.arrayContaining([info.id]))

    const read = await t.get()
    expect(read.status).toBe(200)
    expect(read.headers.get('content-type')).toBe('image/jpeg')
    expect(read.headers.get('cache-control')).toBe('private, no-store')
    expect(Buffer.from(await read.arrayBuffer())).toEqual(Buffer.from(JPEG))
    expect((await t.detail()).photo).toMatchObject({ id: info.id, contentType: 'image/jpeg' })

    // replace with a png: the old file is gone, the new one is served with its real type
    const second = (await (await t.put(PNG, t.token, 'application/octet-stream')).json()).photo
    expect(second.id).not.toBe(info.id)
    expect(second.contentType).toBe('image/png')
    expect(filesOnDisk()).toContain(second.id)
    expect(filesOnDisk()).not.toContain(info.id)
    const again = await t.get()
    expect(again.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await again.arrayBuffer())).toEqual(Buffer.from(PNG))

    const removed = await t.del()
    expect(removed.status).toBe(200)
    expect(filesOnDisk()).not.toContain(second.id)
    expect((await t.get()).status).toBe(404)
    expect((await t.detail()).photo).toBeNull()
    // removing nothing is harmless and leaves no history row
    expect((await t.del()).status).toBe(200)
  })

  it('trusts the bytes, not the Content-Type header or a file name', async () => {
    const t = await setup()
    expect((await t.put(GIF, t.token, 'image/jpeg')).status).toBe(400)
    expect((await t.put('<script>alert(1)</script>', t.token, 'image/png')).status).toBe(400)
    expect((await t.put(new Uint8Array(0))).status).toBe(400)
    const heic = await t.put(HEIC, t.token, 'image/heic')
    expect(heic.status).toBe(400)
    const body = await heic.json()
    expect(body.error.code).toBe('PHOTO_HEIC')
    expect(body.error.message).toMatch(/HEIC/)
    expect((await t.put(JPEG, t.token, 'text/plain')).status).toBe(200)
    expect((await t.detail()).photo.contentType).toBe('image/jpeg')
  })

  it('rejects over 5 MB with 413 and keeps the existing photo', async () => {
    const t = await setup()
    await t.put(JPEG)
    const big = new Uint8Array(PHOTO_MAX_BYTES + 1); big.set(JPEG)
    const res = await t.put(big)
    expect(res.status).toBe(413)
    expect((await res.json()).error.code).toBe('PHOTO_TOO_LARGE')
    const stream = await t.app.request(t.path, {
      method: 'PUT',
      headers: t.headersFor(t.token, { 'content-type': 'image/jpeg' }),
      body: new ReadableStream({ start(c) { c.enqueue(big); c.close() } }),
      // @ts-expect-error node fetch option for streamed bodies
      duplex: 'half',
    })
    expect(stream.status).toBe(413)
    expect((await t.detail()).photo.bytes).toBe(JPEG.length)
  })

  it('serves only group members, on every request, with no unauthenticated or public route', async () => {
    const t = await setup()
    await t.put(JPEG)
    const eve = await sessionFor(t.app, 'eve@example.com')
    expect((await t.get(null)).status).toBe(401)
    expect((await t.get('not-a-token')).status).toBe(401)
    expect((await t.get(eve)).status).toBe(403)
    expect((await t.put(JPEG, eve)).status).toBe(403)
    expect((await t.del(eve)).status).toBe(403)
    expect((await t.detail()).photo).not.toBeNull()
    // no other URL shape exposes the file by id
    const id = (await t.detail()).photo.id
    for (const guess of [`/photos/${id}`, `/api/photos/${id}`, `/data/photos/${id}`, `/${id}`]) {
      const res = await t.app.request(guess, { headers: t.headersFor(t.token) })
      expect(res.headers.get('content-type') ?? '').not.toMatch(/^image\//)
    }
    // the expense id under a group that does not own it is not found, even for a member of both
    const other = (await t.call('POST', '/api/groups', { name: 'Other', currency: 'USD', timezone: 'UTC' })).json.group.id
    const cross = await t.app.request(`/api/groups/${other}/expenses/${t.expenseId}/photo`, { headers: t.headersFor(t.token) })
    expect(cross.status).toBe(404)
  })

  it('a member who joins by invite can see and change it', async () => {
    const t = await setup()
    await t.put(JPEG)
    const invite = await t.call('POST', `/api/groups/${t.groupId}/invite-link`)
    const jordan = await sessionFor(t.app, 'jordan@example.com')
    const accepted = await t.app.request(`/api/invites/${invite.json.token}/accept`, { method: 'POST', headers: t.headersFor(jordan, { 'content-type': 'application/json' }) })
    expect(accepted.status).toBe(200)
    expect((await t.get(jordan)).status).toBe(200)
    expect((await t.put(PNG, jordan)).status).toBe(200)
  })

  it('records add, replace and remove in the history, without touching the expense version or amounts', async () => {
    const t = await setup()
    const before = (await t.detail()).expense
    await t.put(JPEG)
    await t.put(PNG)
    await t.del()
    await t.del() // nothing to remove: no row
    const { history, expense } = await t.detail()
    expect(history.map((h: any) => h.kind)).toEqual(['created', 'edited', 'edited', 'edited'])
    expect(history.slice(1).map((h: any) => h.changes)).toEqual([
      [{ field: 'photo', from: null, to: 'added' }],
      [{ field: 'photo', from: 'added', to: 'replaced' }],
      [{ field: 'photo', from: 'added', to: 'removed' }],
    ])
    expect(history[1].actorName).toBe('Alex')
    expect(expense.version).toBe(before.version)
    expect(expense.originalMinor).toBe(before.originalMinor)
    // a normal edit right after still works with the old version (no stale conflict from the photo)
    expect((await t.call('PATCH', `/api/groups/${t.groupId}/expenses/${t.expenseId}`, { version: before.version, description: 'Dinner at Lou' })).status).toBe(200)
  })

  it('keeps the photo when the expense is deleted, and it comes back with Undo', async () => {
    const t = await setup()
    const id = (await (await t.put(JPEG)).json()).photo.id
    const del = await t.call('DELETE', `/api/groups/${t.groupId}/expenses/${t.expenseId}`, { version: 1 })
    expect(del.status).toBe(200)
    expect(filesOnDisk()).toContain(id)
    // a deleted expense shows no photo (to anyone) and takes no new one; the file waits for Undo
    expect((await t.get()).status).toBe(404)
    expect((await t.put(PNG)).status).toBe(404)
    expect((await t.del()).status).toBe(404)
    expect((await t.call('POST', `/api/groups/${t.groupId}/expenses/${t.expenseId}/restore`)).status).toBe(200)
    expect((await t.get()).status).toBe(200)
    expect((await t.detail()).photo.id).toBe(id)
  })

  it('purging deleted expenses removes old ones with their photo file, and only those', async () => {
    const t = await setup()
    const gone = (await (await t.put(JPEG)).json()).photo.id
    await t.call('DELETE', `/api/groups/${t.groupId}/expenses/${t.expenseId}`, { version: 1 })
    const [you, maya] = t.ids as [string, string]
    const live = (await t.call('POST', `/api/groups/${t.groupId}/expenses`, { ...base, originalMinor: 100, payers: [{ participantId: you, minor: 100 }], split: { type: 'equal', participantIds: [you, maya] } })).json.id
    const kept = (await (await t.app.request(`/api/groups/${t.groupId}/expenses/${live}/photo`, { method: 'PUT', headers: t.headersFor(t.token), body: PNG as never })).json()).photo.id
    // the deleted one is recent: nothing is purged yet
    const { Repo } = await import('./repo.ts')
    const repo = new Repo(t.sql, { now: () => new Date('2026-10-27T15:00:00Z'), photos: createPhotoStore(dir) } as never)
    expect(await repo.purgeDeletedExpenses(30)).toEqual({ purged: 0 })
    expect(filesOnDisk()).toContain(gone)
    await t.sql.query(`update expenses set deleted_at = '2026-08-01T00:00:00Z' where id = $1`, [t.expenseId])
    expect(await repo.purgeDeletedExpenses(30)).toEqual({ purged: 1 })
    expect(filesOnDisk()).not.toContain(gone)
    expect(filesOnDisk()).toContain(kept)
    expect(await t.sql.query(`select 1 from expense_photos where expense_id = $1`, [t.expenseId])).toEqual([])
    expect((await t.sql.query(`select count(*)::int as n from expense_history where expense_id = $1`, [t.expenseId]))[0]).toEqual({ n: 0 })
    expect((await t.get()).status).toBe(404)
  })
})
