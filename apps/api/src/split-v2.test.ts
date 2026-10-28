import { describe, expect, it } from 'vitest'
import { groupOf } from './testkit.ts'

const base = { description: 'Dinner', date: '2026-10-20', originalCurrency: 'USD' }

describe('split storage (design v2)', () => {
  it('stores the method and the raw inputs for every split type and reads them back', async () => {
    const { call, groupId, ids } = await groupOf(['Maya', 'Leo'])
    const [you, maya, leo] = ids as [string, string, string]
    const splits = [
      { type: 'equal', participantIds: [you, maya, leo] },
      { type: 'exact', amounts: [{ participantId: you, minor: 5000 }, { participantId: maya, minor: 3000 }, { participantId: leo, minor: 2000 }] },
      { type: 'percent', parts: [{ participantId: you, bps: 5000 }, { participantId: maya, bps: 3000 }, { participantId: leo, bps: 2000 }] },
      { type: 'shares', parts: [{ participantId: you, weight: 2 }, { participantId: maya, weight: 1 }, { participantId: leo, weight: 1 }] },
      { type: 'adjust', parts: [{ participantId: you, minor: 0 }, { participantId: maya, minor: 0 }, { participantId: leo, minor: 1000 }] },
    ]
    for (const split of splits) {
      const saved = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 10000, payers: [{ participantId: you, minor: 10000 }], split, rounding: 'payer' })
      expect(saved.status, JSON.stringify(split)).toBe(200)
    }
    const { json } = await call('GET', `/api/groups/${groupId}`)
    const byMethod = Object.fromEntries(json.expenses.map((e: any) => [e.splitMethod, e]))
    expect(Object.keys(byMethod).sort()).toEqual(['adjust', 'equal', 'exact', 'percent', 'shares'])
    expect(byMethod.percent.splitInputs).toEqual({ parts: splits[2]!.parts })
    expect(byMethod.equal.shares.map((s: any) => s.minor).sort()).toEqual([3333, 3333, 3334])
    // $100 with Leo +$10: the other $90 splits three ways, so Leo pays $40 and the others $30.
    expect(byMethod.adjust.shares.find((s: any) => s.participantId === leo).minor).toBe(4000)
    expect(byMethod.adjust.shares.find((s: any) => s.participantId === you).minor).toBe(3000)
  })

  it('every stored share set adds up to the total', async () => {
    const { call, groupId, ids } = await groupOf(['Maya', 'Leo'])
    const [you, maya, leo] = ids as [string, string, string]
    for (const total of [1, 2, 100, 101, 9999, 10001]) {
      await call('POST', `/api/groups/${groupId}/expenses`, {
        ...base, originalMinor: total, payers: [{ participantId: maya, minor: total }],
        split: { type: 'percent', parts: [{ participantId: you, bps: 3333 }, { participantId: maya, bps: 3333 }, { participantId: leo, bps: 3334 }] }, rounding: 'payer',
      })
    }
    const { json } = await call('GET', `/api/groups/${groupId}`)
    expect(json.expenses).toHaveLength(6)
    for (const e of json.expenses) expect(e.shares.reduce((n: number, s: any) => n + s.minor, 0)).toBe(e.settlementMinor)
  })

  it('gives odd cents to the payer first by default; rounding legacy keeps the old lowest-id rule', async () => {
    const { call, groupId, ids } = await groupOf(['Maya', 'Leo'])
    const [, maya, leo] = ids as [string, string, string]
    const people = [...ids]
    const make = async (rounding?: string) => {
      const res = await call('POST', `/api/groups/${groupId}/expenses`, {
        ...base, originalMinor: 10000, payers: [{ participantId: leo, minor: 10000 }],
        split: { type: 'equal', participantIds: people }, ...(rounding ? { rounding } : {}),
      })
      expect(res.status).toBe(200)
      return res.json.id as string
    }
    const defaultId = await make()
    const v2Id = await make('payer')
    const legacyId = await make('legacy')
    const { json } = await call('GET', `/api/groups/${groupId}`)
    const shareOf = (id: string, who: string) => json.expenses.find((e: any) => e.id === id).shares.find((s: any) => s.participantId === who).minor
    expect(shareOf(v2Id, leo)).toBe(3334)
    expect(shareOf(v2Id, maya)).toBe(3333)
    expect(shareOf(defaultId, leo)).toBe(3334)
    expect(shareOf(defaultId, maya)).toBe(3333)
    const lowest = [...people].sort()[0]!
    expect(shareOf(legacyId, lowest)).toBe(3334)
  })

  it('refuses shares that do not add up, for every method, and saves nothing', async () => {
    const { call, groupId, ids, detail } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const payers = [{ participantId: you, minor: 12000 }]
    const bad: [string, unknown, string][] = [
      ['exact short', { type: 'exact', amounts: [{ participantId: you, minor: 6000 }, { participantId: maya, minor: 5000 }] }, 'UNBALANCED'],
      ['exact over', { type: 'exact', amounts: [{ participantId: you, minor: 7000 }, { participantId: maya, minor: 6000 }] }, 'UNBALANCED'],
      ['percent 99', { type: 'percent', parts: [{ participantId: you, bps: 5000 }, { participantId: maya, bps: 4900 }] }, 'PERCENT_SUM'],
      ['adjust over total', { type: 'adjust', parts: [{ participantId: you, minor: 5000 }, { participantId: maya, minor: 8000 }] }, 'UNBALANCED'],
      ['adjust negative result', { type: 'adjust', parts: [{ participantId: you, minor: -20000 }, { participantId: maya, minor: 0 }] }, 'BAD_SPLIT'],
      ['adjust empty', { type: 'adjust', parts: [] }, 'BAD_SPLIT'],
      ['adjust bad shape', { type: 'adjust' }, 'BAD_SPLIT'],
      ['negative exact', { type: 'exact', amounts: [{ participantId: you, minor: 13000 }, { participantId: maya, minor: -1000 }] }, 'BAD_SPLIT'],
    ]
    for (const [label, split, code] of bad) {
      const res = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 12000, payers, split, rounding: 'payer' })
      expect(res.status, label).toBe(400)
      expect(res.json.error.code, label).toBe(code)
    }
    expect((await detail()).expenses).toHaveLength(0)
  })

  it('keeps the $100,000 cap and comma-free minor amounts', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const split = { type: 'equal', participantIds: [you, maya] }
    const over = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 10_000_001, payers: [{ participantId: you, minor: 10_000_001 }], split })
    expect(over.status).toBe(400)
    expect(over.json.error.code).toBe('TOO_LARGE')
    const exact = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, originalMinor: 10_000_000, payers: [{ participantId: you, minor: 10_000_000 }], split })
    expect(exact.status).toBe(200)
  })

  it('edits: an amount change replays percent, a method change is recorded, and an exact amount change needs a new split', async () => {
    const { call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const created = await call('POST', `/api/groups/${groupId}/expenses`, {
      ...base, originalMinor: 10000, payers: [{ participantId: you, minor: 10000 }],
      split: { type: 'percent', parts: [{ participantId: you, bps: 7000 }, { participantId: maya, bps: 3000 }] }, rounding: 'payer',
    })
    const id = created.json.id as string
    const read = async () => (await call('GET', `/api/groups/${groupId}/expenses/${id}`)).json
    let detail = await read()
    expect(detail.expense.version).toBe(1)

    // Amount only: the stored percent split is replayed on the new total.
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, originalMinor: 20000 })).status).toBe(200)
    detail = await read()
    expect(detail.expense.shares.map((s: any) => [s.participantId, s.minor])).toEqual(expect.arrayContaining([[you, 14000], [maya, 6000]]))
    expect(detail.expense.splitMethod).toBe('percent')

    // Switch to exact with a new split.
    const exact = { type: 'exact', amounts: [{ participantId: you, minor: 5000 }, { participantId: maya, minor: 15000 }] }
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 2, split: exact, description: 'Dinner out' })).status).toBe(200)
    detail = await read()
    expect(detail.expense.splitMethod).toBe('exact')
    expect(detail.expense.splitInputs).toEqual({ amounts: exact.amounts })

    // An exact expense whose amount changes with no new split can't balance.
    const stuck = await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 3, originalMinor: 30000 })
    expect(stuck.status).toBe(400)
    expect(stuck.json.error.code).toBe('UNBALANCED')
    // A stale save is refused.
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 1, description: 'Nope' })).status).toBe(409)

    // A description-only edit leaves the shares exactly as they were.
    expect((await call('PATCH', `/api/groups/${groupId}/expenses/${id}`, { version: 3, description: 'Dinner at Lou' })).status).toBe(200)
    detail = await read()
    expect(detail.expense.shares.map((s: any) => s.minor).sort((a: number, b: number) => a - b)).toEqual([5000, 15000])

    expect(detail.history.map((h: any) => h.kind)).toEqual(['created', 'edited', 'edited', 'edited'])
    expect(detail.history.every((h: any) => h.actorName === 'Alex')).toBe(true)
    const fields = (n: number) => detail.history[n].changes.map((c: any) => c.field)
    expect(fields(1)).toEqual(expect.arrayContaining(['amount', 'split']))
    expect(fields(1)).not.toContain('method')
    expect(fields(2)).toEqual(expect.arrayContaining(['description', 'method', 'split']))
    expect(detail.history[2].changes.find((c: any) => c.field === 'method')).toEqual({ field: 'method', from: 'percent', to: 'exact' })
    expect(detail.history[3].changes).toEqual([{ field: 'description', from: 'Dinner out', to: 'Dinner at Lou' }])
    expect(detail.history[0].at < detail.history[3].at || detail.history[0].at === detail.history[3].at).toBe(true)
  })

  it('delete and restore are recorded and the balance follows', async () => {
    const { call, groupId, ids, detail } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const created = await call('POST', `/api/groups/${groupId}/expenses`, {
      ...base, originalMinor: 4000, payers: [{ participantId: you, minor: 4000 }], split: { type: 'equal', participantIds: [you, maya] },
    })
    const id = created.json.id as string
    expect((await detail()).nets.find((n: any) => n.participantId === maya).netMinor).toBe(-2000)
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 1 })).status).toBe(200)
    expect((await detail()).nets.find((n: any) => n.participantId === maya).netMinor).toBe(0)
    expect((await call('POST', `/api/groups/${groupId}/expenses/${id}/restore`)).status).toBe(200)
    expect((await detail()).nets.find((n: any) => n.participantId === maya).netMinor).toBe(-2000)
    const read = (await call('GET', `/api/groups/${groupId}/expenses/${id}`)).json
    expect(read.history.map((h: any) => h.kind)).toEqual(['created', 'deleted', 'restored'])
    expect((await call('GET', `/api/groups/${groupId}/expenses/nope`)).status).toBe(404)
  })

  it('only members can read an expense and its history', async () => {
    const { app, groupId, ids, call } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const created = await call('POST', `/api/groups/${groupId}/expenses`, {
      ...base, originalMinor: 4000, payers: [{ participantId: you, minor: 4000 }], split: { type: 'equal', participantIds: [you, maya] },
    })
    const { sessionFor } = await import('./testkit.ts')
    const other = await sessionFor(app, 'eve@example.com')
    const res = await app.request(`/api/groups/${groupId}/expenses/${created.json.id}`, { headers: { authorization: `Bearer ${other}` } })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

describe('percent split carrying its cents (API)', () => {
  it('stores the carried cents and rejects ones that are not a rounding of the percents', async () => {
    const { call, groupId, ids } = await groupOf(['Maya', 'Leo', 'Priya'])
    const [you, maya, leo, priya] = ids as [string, string, string, string]
    const parts = [
      { participantId: you, bps: 2508, minor: 251 },
      { participantId: maya, bps: 3497, minor: 350 },
      { participantId: leo, bps: 2497, minor: 250 },
      { participantId: priya, bps: 1498, minor: 150 },
    ]
    const body = (split: unknown) => ({ ...base, originalMinor: 1001, payers: [{ participantId: you, minor: 1001 }], split, rounding: 'payer' })
    const ok = await call('POST', `/api/groups/${groupId}/expenses`, body({ type: 'percent', parts }))
    expect(ok.status).toBe(200)
    const { json } = await call('GET', `/api/groups/${groupId}`)
    const shares = Object.fromEntries(json.expenses[0].shares.map((s: any) => [s.participantId, s.minor]))
    expect(shares).toEqual({ [you]: 251, [maya]: 350, [leo]: 250, [priya]: 150 })
    const moved = parts.map((p, i) => (i === 0 ? { ...p, minor: 252 } : i === 1 ? { ...p, minor: 349 } : p))
    expect((await call('POST', `/api/groups/${groupId}/expenses`, body({ type: 'percent', parts: moved }))).status).toBe(400)
    const short = parts.map((p, i) => (i === 0 ? { ...p, minor: 250 } : p))
    expect((await call('POST', `/api/groups/${groupId}/expenses`, body({ type: 'percent', parts: short }))).status).toBe(400)
  })
})

describe('same-day expenses sort by created time, then id (API)', () => {
  it('lists newest day first, then newest created, then id', async () => {
    const { call, groupId, ids, sql } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const add = async (description: string, date: string) => {
      const res = await call('POST', `/api/groups/${groupId}/expenses`, { ...base, description, date, originalMinor: 1000, payers: [{ participantId: you, minor: 1000 }], split: { type: 'equal', participantIds: [you, maya] } })
      expect(res.status).toBe(200)
      return res.json.id as string
    }
    const a = await add('first', '2026-10-20')
    const b = await add('second', '2026-10-20')
    const c = await add('third', '2026-10-20')
    const old = await add('older day', '2026-10-19')
    const stamp = async (id: string, iso: string) => { await sql.query(`update expenses set created_at = $2 where id = $1`, [id, iso]) }
    await stamp(a, '2026-10-20T10:00:00Z')
    await stamp(b, '2026-10-20T12:00:00Z')
    await stamp(c, '2026-10-20T12:00:00Z')
    await stamp(old, '2026-10-21T00:00:00Z')
    const { json } = await call('GET', `/api/groups/${groupId}`)
    const tie = [b, c].sort().reverse()
    expect(json.expenses.map((e: any) => e.id)).toEqual([...tie, a, old])
    expect(json.expenses.every((e: any) => typeof e.createdAt === 'string')).toBe(true)
  })
})
