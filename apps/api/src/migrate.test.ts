import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { FIXED_CATEGORIES } from '@divvy/domain'
import { inferSplit, migrateSplitStorage } from './migrate.ts'
import type { Sql } from './db.ts'
import { createApp } from './app.ts'

const preV2Schema = readFileSync(new URL('./fixtures/schema-pre-v2.sql', import.meta.url), 'utf8')
const v2Schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

const wrap = (db: PGlite): Sql => ({
  async query(text, params = []) { return (await db.query(text, params as never[])).rows as never },
  async exec(text) { await db.exec(text) },
  async tx(fn) { return db.transaction((tx) => fn(wrap(tx as unknown as PGlite))) },
})

/** A database exactly as the pre-v2 schema left it: equal, uneven, custom, itemized and no-activity expenses. */
async function seedLegacy(dir: string) {
  const db = new PGlite(dir)
  await db.exec(preV2Schema)
  const sql = wrap(db)
  for (const c of FIXED_CATEGORIES) await sql.query(`insert into categories (id, group_id, label, fixed) values ($1,null,$2,true) on conflict do nothing`, [c.id, c.label])
  await sql.query(`insert into users (id, email, display_name) values ('u1','alex@example.com','Alex')`)
  for (const [id, name, user] of [['p1', 'Alex', 'u1'], ['p2', 'Bob', null], ['p3', 'Cy', null]] as const) {
    await sql.query(`insert into participants (id, display_name, email, user_id) values ($1,$2,null,$3)`, [id, name, user])
  }
  await sql.query(`insert into groups (id, name, settlement_currency, timezone) values ('g1','Trip','USD','UTC')`)
  for (const p of ['p1', 'p2', 'p3']) await sql.query(`insert into memberships (group_id, participant_id) values ('g1',$1)`, [p])
  const cat = FIXED_CATEGORIES[0]!.id
  const expense = async (id: string, total: number, shares: [string, number][], when: string) => {
    await sql.query(
      `insert into expenses (id, group_id, expense_date, description, category_id, kind, original_currency, original_minor, settlement_minor, created_at)
       values ($1,'g1','2026-09-01',$2,$3,'expense','USD',$4,$4,$5)`,
      [id, id, cat, total, when],
    )
    await sql.query(`insert into expense_lines (expense_id, participant_id, role, minor) values ($1,'p1','payer',$2)`, [id, total])
    for (const [p, m] of shares) await sql.query(`insert into expense_lines (expense_id, participant_id, role, minor) values ($1,$2,'share',$3)`, [id, p, m])
  }
  await expense('equal3', 1000, [['p1', 333], ['p2', 333], ['p3', 334]], '2026-09-01T10:00:00Z')
  await expense('uneven', 1000, [['p1', 600], ['p2', 400]], '2026-09-02T10:00:00Z')
  await expense('zero', 2000, [['p1', 0], ['p2', 2000]], '2026-09-03T10:00:00Z')
  await expense('itemized', 1000, [['p1', 500], ['p2', 500]], '2026-09-04T10:00:00Z')
  await sql.query(`insert into expense_items (id, expense_id, label, minor, position) values ('i1','itemized','Pizza',1000,0)`)
  await expense('orphan', 500, [['p1', 250], ['p2', 250]], '2026-09-05T10:00:00Z')
  const act = (id: string, kind: string, expenseId: string, at: string) =>
    sql.query(`insert into activity (id, group_id, actor_participant_id, kind, summary, payload, created_at) values ($1,'g1','p1',$2,'x',$3,$4)`, [id, kind, JSON.stringify({ expenseId }), at])
  await act('a1', 'expense.created', 'equal3', '2026-09-01T10:00:01Z')
  await act('a2', 'expense.updated', 'equal3', '2026-09-01T11:00:00Z')
  await act('a3', 'expense.created', 'uneven', '2026-09-02T10:00:01Z')
  await act('a4', 'expense.deleted', 'uneven', '2026-09-02T12:00:00Z')
  await act('a5', 'expense.restored', 'uneven', '2026-09-02T13:00:00Z')
  await act('a6', 'expense.created', 'zero', '2026-09-03T10:00:01Z')
  await act('a7', 'expense.created', 'itemized', '2026-09-04T10:00:01Z')
  await act('a8', 'group.created', 'nothing', '2026-09-01T09:00:00Z')
  await sql.query(`insert into settlements (id, group_id, settlement_date, from_participant_id, to_participant_id, minor, note) values ('s1','g1','2026-09-06','p2','p1',100,'')`).catch(() => undefined)
  await db.close()
}

describe('migration to split storage (design v2)', () => {
  it('infers equal vs exact from stored share lines', () => {
    const line = (p: string, minor: number) => ({ participant_id: p, minor })
    expect(inferSplit([line('a', 333), line('b', 333), line('c', 334)], false).method).toBe('equal')
    expect(inferSplit([line('a', 600), line('b', 400)], false)).toEqual({ method: 'exact', inputs: { amounts: [{ participantId: 'a', minor: 600 }, { participantId: 'b', minor: 400 }] } })
    expect(inferSplit([line('a', 500), line('b', 500)], true).method).toBe('exact')
    expect(inferSplit([], false).method).toBe('exact')
  })

  it('migrates a copy of an old database, leaves the original untouched, changes no amount, and is idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'divvy-mig-'))
    try {
      const original = join(root, 'original')
      const copy = join(root, 'copy')
      await seedLegacy(original)
      cpSync(original, copy, { recursive: true })

      const before = new PGlite(copy)
      const beforeSql = wrap(before)
      const amountsBefore = await beforeSql.query(`select expense_id, participant_id, role, minor from expense_lines order by 1,2,3`)
      const totalsBefore = await beforeSql.query(`select id, settlement_minor from expenses order by id`)
      // Apply the new schema the way a server start does, then migrate.
      await before.exec(v2Schema)
      const first = await migrateSplitStorage(beforeSql)
      expect(first).toEqual({ methods: 5, history: 8 })
      const again = await migrateSplitStorage(beforeSql)
      expect(again).toEqual({ methods: 0, history: 0 })

      const methods = Object.fromEntries((await beforeSql.query<{ id: string; split_method: string; split_inputs: string }>(`select id, split_method, split_inputs from expenses`)).map((r) => [r.id, r]))
      expect(methods.equal3!.split_method).toBe('equal')
      expect(JSON.parse(methods.equal3!.split_inputs)).toEqual({ participantIds: ['p1', 'p2', 'p3'] })
      expect(methods.uneven!.split_method).toBe('exact')
      expect(JSON.parse(methods.uneven!.split_inputs)).toEqual({ amounts: [{ participantId: 'p1', minor: 600 }, { participantId: 'p2', minor: 400 }] })
      expect(methods.zero!.split_method).toBe('exact')
      expect(methods.itemized!.split_method).toBe('exact') // two equal halves, but entered as items
      expect(methods.orphan!.split_method).toBe('equal')

      expect(await beforeSql.query(`select expense_id, participant_id, role, minor from expense_lines order by 1,2,3`)).toEqual(amountsBefore)
      expect(await beforeSql.query(`select id, settlement_minor from expenses order by id`)).toEqual(totalsBefore)

      const history = await beforeSql.query<{ expense_id: string; kind: string; actor_participant_id: string | null; changes: string | null }>(
        `select expense_id, kind, actor_participant_id, changes from expense_history order by expense_id, created_at, seq`,
      )
      const kinds = (id: string) => history.filter((h) => h.expense_id === id).map((h) => h.kind)
      expect(kinds('equal3')).toEqual(['created', 'edited'])
      expect(kinds('uneven')).toEqual(['created', 'deleted', 'restored'])
      expect(kinds('orphan')).toEqual(['created']) // no activity: a created row dated from the expense itself
      expect(history.find((h) => h.expense_id === 'orphan')!.actor_participant_id).toBeNull()
      expect(history.find((h) => h.expense_id === 'equal3')!.actor_participant_id).toBe('p1')
      expect(history.every((h) => h.changes === null)).toBe(true)
      await before.close()

      // The original directory was never opened by the migration, so it is still the old shape.
      const untouched = new PGlite(original)
      const cols = await untouched.query(`select column_name from information_schema.columns where table_name = 'expenses' and column_name = 'split_method'`)
      expect(cols.rows).toHaveLength(0)
      await untouched.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('a migrated expense can be edited through the API and keeps its history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'divvy-mig-'))
    try {
      const dir = join(root, 'db')
      await seedLegacy(dir)
      const db = new PGlite(dir)
      await db.exec(v2Schema)
      const sql = wrap(db)
      await migrateSplitStorage(sql)
      const { app } = createApp(sql, { now: () => new Date('2026-10-27T15:00:00Z'), dev: true, rateFor: async () => '1' })
      const started = await (await app.request('/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', 'x-divvy-platform': 'ios' }, body: JSON.stringify({ email: 'alex@example.com' }) })).json() as { devToken: string }
      const verified = await (await app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-divvy-platform': 'ios' }, body: JSON.stringify({ token: started.devToken }) })).json() as { token: string }
      const headers = { authorization: `Bearer ${verified.token}`, 'content-type': 'application/json' }
      const detail = await (await app.request('/api/groups/g1/expenses/equal3', { headers })).json() as { expense: { splitMethod: string; version: number; shares: { minor: number }[] }; history: { kind: string }[] }
      expect(detail.expense.splitMethod).toBe('equal')
      expect(detail.expense.shares.map((s) => s.minor).sort()).toEqual([333, 333, 334])
      expect(detail.history.map((h) => h.kind)).toEqual(['created', 'edited'])
      // Amount edit on a migrated *equal* expense replays equal on the new total.
      const patched = await app.request('/api/groups/g1/expenses/equal3', { method: 'PATCH', headers, body: JSON.stringify({ version: detail.expense.version, originalMinor: 3000 }) })
      expect(patched.status).toBe(200)
      const after = await (await app.request('/api/groups/g1/expenses/equal3', { headers })).json() as { expense: { shares: { minor: number }[] }; history: { kind: string }[] }
      expect(after.expense.shares.map((s) => s.minor)).toEqual([1000, 1000, 1000])
      expect(after.history.map((h) => h.kind)).toEqual(['created', 'edited', 'edited'])
      await db.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
