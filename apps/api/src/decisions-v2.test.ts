import { describe, expect, it } from 'vitest'
import { groupOf, sessionFor } from './testkit.ts'

const base = { description: 'Dinner', date: '2026-10-20', originalCurrency: 'USD' }

async function joined(names: string[] = []) {
  const ctx = await groupOf(names)
  const invite = await ctx.call('POST', `/api/groups/${ctx.groupId}/invite-link`)
  const jordanToken = await sessionFor(ctx.app, 'jordan@example.com')
  const jh = { authorization: `Bearer ${jordanToken}`, 'content-type': 'application/json' }
  const acc = await ctx.app.request(`/api/invites/${invite.json.token}/accept`, { method: 'POST', headers: jh })
  expect(acc.status).toBe(200)
  const jcall = async (method: string, path: string, body?: unknown) => {
    const res = await ctx.app.request(path, { method, headers: jh, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  const members = (await acc.json() as { members: { id: string; name: string }[] }).members
  return { ...ctx, jcall, members }
}

describe('design v2 decisions: concurrency, membership, emoji, adjust', () => {
  it('DELETE needs the current version: missing and stale are 409 STALE, query or body both work', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const mk = async () => (await call('POST', `/api/groups/${groupId}/expenses`, {
      ...base, originalMinor: 4000, payers: [{ participantId: you, minor: 4000 }], split: { type: 'equal', participantIds: [you, maya] },
    })).json.id as string
    const id = await mk()
    const missing = await call('DELETE', `/api/groups/${groupId}/expenses/${id}`)
    expect(missing.status).toBe(409)
    expect(missing.json.error.code).toBe('STALE')
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 7 })).status).toBe(409)
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}?version=9`)).status).toBe(409)
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}?version=abc`)).status).toBe(409)
    // Nothing was deleted by the refused attempts.
    expect((await call('GET', `/api/groups/${groupId}/expenses/${id}`)).json.expense.deleted).not.toBe(true)
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}?version=1`)).status).toBe(200)

    const id2 = await mk()
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id2}`, { version: 1 })).status).toBe(200)
  })

  it('a PATCH after someone else changed the expense is 409 STALE and changes nothing', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const id = (await call('POST', `/api/groups/${groupId}/expenses`, {
      ...base, originalMinor: 4000, payers: [{ participantId: you, minor: 4000 }], split: { type: 'equal', participantIds: [you, maya] },
    })).json.id as string
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, description: 'First' })).status).toBe(200)
    const stale = await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, description: 'Second' })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('STALE')
    const read = (await call('GET', `/api/groups/${groupId}/expenses/${id}`)).json
    expect(read.expense.description).toBe('First')
    expect(read.expense.version).toBe(2)
    // A delete that raced with the edit is stale too (it saw version 1).
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 1 })).status).toBe(409)
  })

  it('any member can edit and delete, and history records who did it, when, and before/after', async () => {
    const { call, jcall, groupId, ids, members } = await joined(['Maya'])
    const jordan = members.find((m) => m.name === 'Jordan')!
    const [you, maya] = ids as [string, string]
    const id = (await call('POST', `/api/groups/${groupId}/expenses`, {
      ...base, originalMinor: 6000, payers: [{ participantId: you, minor: 6000 }], split: { type: 'equal', participantIds: [you, maya, jordan.id] },
    })).json.id as string
    // Jordan did not create it and did not pay for it.
    expect((await jcall('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, description: 'Dinner at Lou', originalMinor: 9000 })).status).toBe(200)
    expect((await jcall('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 2 })).status).toBe(200)
    expect((await call('POST', `/api/groups/${groupId}/expenses/${id}/restore`)).status).toBe(200)
    const { history } = (await call('GET', `/api/groups/${groupId}/expenses/${id}`)).json
    expect(history.map((h: any) => [h.kind, h.actorName])).toEqual([['created', 'Alex'], ['edited', 'Jordan'], ['deleted', 'Jordan'], ['restored', 'Alex']])
    expect(history.every((h: any) => typeof h.at === 'string' && h.at.length > 10)).toBe(true)
    expect(history[1].changes).toEqual(expect.arrayContaining([
      { field: 'description', from: 'Dinner', to: 'Dinner at Lou' },
    ]))
    const amount = history[1].changes.find((c: any) => c.field === 'amount')
    expect(JSON.stringify(amount)).toContain('6000')
    expect(JSON.stringify(amount)).toContain('9000')
  })

  it('a non-member cannot edit or delete', async () => {
    const { app, call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const id = (await call('POST', `/api/groups/${groupId}/expenses`, {
      ...base, originalMinor: 4000, payers: [{ participantId: you, minor: 4000 }], split: { type: 'equal', participantIds: [you, maya] },
    })).json.id as string
    const eve = await sessionFor(app, 'eve@example.com')
    const h = { authorization: `Bearer ${eve}`, 'content-type': 'application/json' }
    const patch = await app.request(`/api/groups/${groupId}/expenses/${id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ version: 1, description: 'x' }) })
    const del = await app.request(`/api/groups/${groupId}/expenses/${id}`, { method: 'DELETE', headers: h, body: JSON.stringify({ version: 1 }) })
    for (const r of [patch, del]) { expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500) }
    const read = (await call('GET', `/api/groups/${groupId}/expenses/${id}`)).json
    expect(read.expense.description).toBe('Dinner')
    expect(read.history.map((x: any) => x.kind)).toEqual(['created'])
  })

  it('groups.emoji: set on create, shown on home and detail, changed, cleared, and validated', async () => {
    const { call, groupId } = await groupOf([])
    expect((await call('GET', `/api/groups/${groupId}`)).json.group.emoji).toBeNull()
    const made = await call('POST', '/api/groups', { name: 'Trip', currency: 'USD', timezone: 'UTC', emoji: '🏔️' })
    expect(made.status).toBe(200)
    const gid = made.json.group.id as string
    expect(made.json.group.emoji).toBe('🏔️')
    expect((await call('GET', `/api/groups/${gid}`)).json.group.emoji).toBe('🏔️')
    const home = await call('GET', '/api/home')
    const row = home.json.groups.find((g: any) => g.id === gid)
    expect(row.emoji).toBe('🏔️')

    const upd = await call('PATCH', `/api/groups/${gid}`, { emoji: '🏠' })
    expect(upd.status).toBe(200)
    expect((await call('GET', `/api/groups/${gid}`)).json.group.emoji).toBe('🏠')
    // Untouched when not sent.
    expect((await call('PATCH', `/api/groups/${gid}`, { name: 'Trip 2' })).status).toBe(200)
    expect((await call('GET', `/api/groups/${gid}`)).json.group.emoji).toBe('🏠')
    // Cleared.
    expect((await call('PATCH', `/api/groups/${gid}`, { emoji: null })).status).toBe(200)
    expect((await call('GET', `/api/groups/${gid}`)).json.group.emoji).toBeNull()

    for (const bad of ['abc', '🏠🏠', 'hi 🏠', '<b>']) {
      const r = await call('POST', '/api/groups', { name: 'Bad', currency: 'USD', timezone: 'UTC', emoji: bad })
      expect(r.status, bad).toBe(400)
      expect(r.json.error.code).toBe('BAD_EMOJI')
      expect((await call('PATCH', `/api/groups/${gid}`, { emoji: bad })).status, bad).toBe(400)
    }
  })

  it('adjust: stores final shares + raw adjustments, rejects negative shares and sum mismatches', async () => {
    const { call, groupId, ids } = await groupOf(['Maya', 'Leo'])
    const [you, maya, leo] = ids as [string, string, string]
    const payers = [{ participantId: you, minor: 12000 }]
    const parts = (a: number, b: number, c: number) => [{ participantId: you, minor: a }, { participantId: maya, minor: b }, { participantId: leo, minor: c }]
    const ok = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 12000, payers, split: { type: 'adjust', parts: parts(0, 0, 1000) }, rounding: 'payer' })
    expect(ok.status).toBe(200)
    const e = (await call('GET', `/api/groups/${groupId}/expenses/${ok.json.id}`)).json.expense
    expect(e.splitMethod).toBe('adjust')
    expect(e.splitInputs).toEqual({ parts: parts(0, 0, 1000) })
    expect(e.shares.reduce((s: number, x: any) => s + x.minor, 0)).toBe(12000)
    expect(e.shares.find((s: any) => s.participantId === leo).minor).toBe(4666)

    // Adjustments larger than the total would leave negative shares.
    const neg = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 12000, payers, split: { type: 'adjust', parts: parts(0, 0, 13000) }, rounding: 'payer' })
    expect(neg.status).toBe(400)
    // A person pushed below zero even though the total matches.
    const below = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 12000, payers, split: { type: 'adjust', parts: parts(-9000, 0, 9000) }, rounding: 'payer' })
    expect(below.status).toBe(400)
    // Exact shares that do not add up, and negative exact shares.
    const mismatch = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 12000, payers, split: { type: 'exact', amounts: parts(5000, 5000, 1000) } })
    expect(mismatch.status).toBe(400)
    const negExact = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 12000, payers, split: { type: 'exact', amounts: parts(13000, -1000, 0) } })
    expect(negExact.status).toBe(400)
    expect((await call('GET', `/api/groups/${groupId}`)).json.expenses.length).toBe(1)
  })

  it('raw inputs round-trip through an edit so the editor reopens in the same mode', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const payers = [{ participantId: you, minor: 10000 }]
    const adjust = { type: 'adjust', parts: [{ participantId: you, minor: 0 }, { participantId: maya, minor: 500 }] }
    const id = (await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 10000, payers, split: adjust, rounding: 'payer' })).json.id as string
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, description: 'Renamed' })).status).toBe(200)
    let e = (await call('GET', `/api/groups/${groupId}/expenses/${id}`)).json.expense
    expect(e.splitMethod).toBe('adjust')
    expect(e.splitInputs).toEqual({ parts: adjust.parts })
    const shares = { type: 'shares', parts: [{ participantId: you, weight: 3 }, { participantId: maya, weight: 1 }] }
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 2, split: shares, rounding: 'payer' })).status).toBe(200)
    e = (await call('GET', `/api/groups/${groupId}/expenses/${id}`)).json.expense
    expect(e.splitMethod).toBe('shares')
    expect(e.splitInputs).toEqual({ parts: shares.parts })
    expect(e.shares.map((s: any) => s.minor).sort((a: number, b: number) => a - b)).toEqual([2500, 7500])
  })
})
