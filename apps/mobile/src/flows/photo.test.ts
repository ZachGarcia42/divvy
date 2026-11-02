import { describe, expect, it } from 'vitest'
import {
  deleteReceipt, fitWithin, KEEP_PHOTO, megabytes, photoDirty, photoErrorText, photoPlan, PHOTO_MAX_EDGE, receiptPath, remoteSource, removeDraft,
  savedWithPhotoProblem, shownPhoto, uploadReceipt, type PickedPhoto,
} from './photo'
import type { PhotoInfo } from '../types'

// React Native's Blob type is narrower than the DOM one; the bytes are the same.
const blobOf = (bytes: Uint8Array, _type = '') => new Blob([bytes as unknown as string])
const info: PhotoInfo = { id: 'a'.repeat(32), contentType: 'image/jpeg', bytes: 1234, at: '2026-10-27T15:12:00Z' }
const picked: PickedPhoto = { uri: 'file:///x.jpg', width: 800, height: 1200 }

describe('fitWithin', () => {
  it('scales the long edge down to 1600px and keeps the shape', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 })
    expect(PHOTO_MAX_EDGE).toBe(1600)
  })
  it('never scales a small photo up', () => { expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 }) })
  it('never returns a zero-sized edge', () => { expect(fitWithin(16000, 5)).toEqual({ width: 1600, height: 1 }) })
})

describe('the receipt draft in the Add/Edit sheet', () => {
  it('does nothing when untouched', () => {
    expect(photoPlan(null, KEEP_PHOTO)).toBe('none')
    expect(photoPlan(info, KEEP_PHOTO)).toBe('none')
    expect(photoDirty(info, KEEP_PHOTO)).toBe(false)
    expect(shownPhoto(info, KEEP_PHOTO)).toEqual({ kind: 'current', info })
    expect(shownPhoto(null, KEEP_PHOTO)).toEqual({ kind: 'none' })
  })
  it('uploads a new or replacement photo', () => {
    expect(photoPlan(null, { kind: 'set', photo: picked })).toBe('upload')
    expect(photoPlan(info, { kind: 'set', photo: picked })).toBe('upload')
    expect(shownPhoto(info, { kind: 'set', photo: picked })).toEqual({ kind: 'new', photo: picked })
    expect(photoDirty(null, { kind: 'set', photo: picked })).toBe(true)
  })
  it('removing the saved photo is a pending delete; removing one not yet saved just forgets it', () => {
    const removed = removeDraft(info, KEEP_PHOTO)
    expect(removed).toEqual({ kind: 'remove' })
    expect(photoPlan(info, removed)).toBe('delete')
    expect(shownPhoto(info, removed)).toEqual({ kind: 'none' })
    expect(removeDraft(null, { kind: 'set', photo: picked })).toBe(KEEP_PHOTO)
    expect(photoDirty(null, removeDraft(null, { kind: 'set', photo: picked }))).toBe(false)
  })
  it('replace then remove on a saved photo still deletes it', () => {
    expect(photoPlan(info, removeDraft(info, { kind: 'set', photo: picked }))).toBe('delete')
  })
  it('a remove with nothing saved does nothing', () => { expect(photoPlan(null, { kind: 'remove' })).toBe('none') })
})

describe('error wording', () => {
  const err = (code: string, message = 'Request failed') => Object.assign(new Error(message), { code })
  it('explains the known problems in plain words', () => {
    expect(photoErrorText(err('PHOTO_TOO_LARGE'))).toMatch(/5 MB/)
    expect(photoErrorText(err('PHOTO_HEIC'))).toMatch(/JPEG or PNG/)
    expect(photoErrorText(err('PHOTO_TYPE'))).toMatch(/JPEG, PNG and WebP/)
    expect(photoErrorText(err('NETWORK'))).toMatch(/Couldn’t reach Divvy/)
    expect(photoErrorText(err('PHOTO_PERMISSION'))).toMatch(/camera/i)
  })
  it('falls back to the server message, then to a default', () => {
    expect(photoErrorText(err('X', 'Not in this group'))).toBe('Not in this group')
    expect(photoErrorText(err('X'))).toMatch(/Try again/)
    expect(photoErrorText(null)).toMatch(/Try again/)
  })
  it('says the expense saved even though the photo did not', () => {
    expect(savedWithPhotoProblem(false, err('NETWORK'))).toMatch(/^Expense added, but the photo didn’t save/)
    expect(savedWithPhotoProblem(true, err('PHOTO_TOO_LARGE'))).toMatch(/^Expense updated, but the photo didn’t save/)
  })
  it('sizes in MB', () => { expect(megabytes(1.2 * 1024 * 1024)).toBe('1.2 MB'); expect(megabytes(0)).toBe('0.0 MB') })
})

type Call = { url: string; init?: RequestInit }
function fakeFetch(respond: (call: Call) => Response | Promise<Response>, calls: Call[] = []) {
  const fn = (async (url: string, init?: RequestInit) => { const call = { url, init }; calls.push(call); return respond(call) }) as unknown as typeof fetch
  return { fn, calls }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const api = (fetchImpl: typeof fetch) => ({ base: 'https://api.test', token: 'tok', platform: 'ios', fetchImpl })

describe('uploading and deleting', () => {
  it('PUTs the raw JPEG bytes with the bearer token, no JSON wrapper', async () => {
    const blob = blobOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg')
    const { fn, calls } = fakeFetch(() => json(200, { photo: info }))
    const saved = await uploadReceipt(api(fn), 'g1', 'e1', { ...picked, blob })
    expect(saved).toEqual(info)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://api.test${receiptPath('g1', 'e1')}`)
    expect(calls[0]!.init?.method).toBe('PUT')
    expect(calls[0]!.init?.body).toBe(blob)
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'image/jpeg', 'x-divvy-platform': 'ios' })
  })
  it('reads a local file first when it has no Blob yet (native)', async () => {
    const { fn, calls } = fakeFetch((call) => (call.url.startsWith('file:') ? new Response(blobOf(new Uint8Array([1, 2, 3]))) : json(200, { photo: info })))
    await uploadReceipt(api(fn), 'g1', 'e1', picked)
    expect(calls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET', 'PUT'])
  })
  it('refuses a photo over 5 MB before sending anything', async () => {
    const big = blobOf(new Uint8Array(5 * 1024 * 1024 + 1))
    const { fn, calls } = fakeFetch(() => json(200, { photo: info }))
    await expect(uploadReceipt(api(fn), 'g1', 'e1', { ...picked, blob: big })).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' })
    expect(calls).toHaveLength(0)
  })
  it('turns a server refusal into an error with its code', async () => {
    const { fn } = fakeFetch(() => json(400, { error: { code: 'PHOTO_HEIC', message: 'nope' } }))
    await expect(uploadReceipt(api(fn), 'g1', 'e1', { ...picked, blob: blobOf(new Uint8Array(4)) })).rejects.toMatchObject({ code: 'PHOTO_HEIC', status: 400 })
  })
  it('reports a network failure as NETWORK', async () => {
    const fn = (async () => { throw new TypeError('offline') }) as unknown as typeof fetch
    await expect(uploadReceipt(api(fn), 'g1', 'e1', { ...picked, blob: blobOf(new Uint8Array(4)) })).rejects.toMatchObject({ code: 'NETWORK' })
    await expect(deleteReceipt(api(fn), 'g1', 'e1')).rejects.toMatchObject({ code: 'NETWORK' })
  })
  it('DELETE sends the token and fails on a non-2xx', async () => {
    const ok = fakeFetch(() => json(200, { ok: true }))
    await deleteReceipt(api(ok.fn), 'g1', 'e1')
    expect(ok.calls[0]!.init?.method).toBe('DELETE')
    expect(ok.calls[0]!.init?.headers).toMatchObject({ authorization: 'Bearer tok' })
    const bad = fakeFetch(() => json(403, { error: { code: 'FORBIDDEN', message: 'no' } }))
    await expect(deleteReceipt(api(bad.fn), 'g1', 'e1')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })
})

describe('where a saved receipt is fetched from', () => {
  it('is the group-member-only route, keyed by the photo id so a replacement refreshes', () => {
    const src = remoteSource({ base: 'https://api.test', token: 'tok', platform: 'android' }, 'g1', 'e1', info)
    expect(src).toEqual({ kind: 'remote', url: `https://api.test/api/groups/g1/expenses/e1/photo?v=${info.id}`, headers: { authorization: 'Bearer tok', 'x-divvy-platform': 'android' }, key: info.id })
  })
  it('sends no Authorization header when signed out', () => {
    const src = remoteSource({ base: '', token: null, platform: 'web' }, 'g1', 'e1', info)
    expect(src.kind === 'remote' && 'authorization' in src.headers).toBe(false)
  })
})
