import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { groupOf } from './testkit.ts'

const schema = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')

describe('activity feed migration (additive)', () => {
  it('only adds an index: running the schema over a database without it changes no rows, and running it again is a no-op', async () => {
    const { sql, call, groupId, ids } = await groupOf(['Maya'])
    const [you, maya] = ids as [string, string]
    await call('POST', `/api/groups/${groupId}/expenses`, { description: 'Dinner', date: '2026-10-20', originalCurrency: 'USD', originalMinor: 4000, payers: [{ participantId: you, minor: 4000 }], split: { type: 'equal', participantIds: [you, maya] } })
    await sql.query('drop index activity_feed')
    const indexes = async () => (await sql.query<{ indexname: string }>(`select indexname from pg_indexes where tablename = 'activity' order by 1`)).map((row) => row.indexname)
    expect(await indexes()).not.toContain('activity_feed')

    const tables = ['users', 'participants', 'groups', 'memberships', 'expenses', 'expense_lines', 'expense_history', 'settlements', 'activity']
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await sql.query<{ j: string }>(`select to_jsonb(x)::text as j from ${table} x`)).map((row) => row.j).sort()] as const)))
    const before = await snapshot()

    await sql.exec(schema)
    expect(await indexes()).toContain('activity_feed')
    expect(await snapshot()).toEqual(before)
    await sql.exec(schema)
    expect(await snapshot()).toEqual(before)
    expect((await indexes()).filter((name) => name === 'activity_feed')).toHaveLength(1)
  })

  it('the paging query uses the new index', async () => {
    const { sql, groupId } = await groupOf([])
    await sql.exec('set enable_seqscan = off')
    const plan = await sql.query<{ 'QUERY PLAN': string }>(
      `explain select id from activity where group_id = $1 order by created_at desc, id desc limit 31`, [groupId],
    )
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('activity_feed')
  })
})
