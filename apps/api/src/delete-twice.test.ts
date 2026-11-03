import { describe, expect, it } from 'vitest'
import { groupOf } from './testkit.ts'

// FD-08: deleting an expense that is already deleted must be refused with no side effects.
describe('deleting an expense twice', () => {
  it('is a 409 and writes nothing: no version bump, no second feed row, history row, or notification', async () => {
    const { call, sql, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    const id = (await call('POST', `/api/groups/${groupId}/expenses`, {
      description: 'Dinner', date: '2026-10-20', originalCurrency: 'USD', originalMinor: 4000,
      payers: [{ participantId: you, minor: 4000 }], split: { type: 'equal', participantIds: [you, maya] },
    })).json.id as string
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 1 })).status).toBe(200)

    const count = async (table: string) => Number((await sql.query<{ n: string }>(`select count(*) as n from ${table}`))[0]!.n)
    const before = { activity: await count('activity'), history: await count('expense_history'), notifications: await count('notifications') }
    const versionOf = async () => Number((await sql.query<{ v: number }>(`select version as v from expenses where id = $1`, [id]))[0]!.v)
    expect(await versionOf()).toBe(2)

    for (const version of [2, 1, 3]) {
      const again = await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version })
      expect(again.status).toBe(409)
      expect(again.json.error.code).toBe('STALE')
    }
    expect(await versionOf()).toBe(2)
    expect({ activity: await count('activity'), history: await count('expense_history'), notifications: await count('notifications') }).toEqual(before)

    // Undo still works, and the expense can be deleted again afterwards.
    expect((await call('POST', `/api/groups/${groupId}/expenses/${id}/restore`)).status).toBe(200)
    expect((await call('DELETE', `/api/groups/${groupId}/expenses/${id}`, { version: 3 })).status).toBe(200)
  })
})
