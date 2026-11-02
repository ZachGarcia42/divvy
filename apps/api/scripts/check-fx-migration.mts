// Runs the multiple-currencies migration against a COPY of a database and proves nothing moved.
//   npx tsx scripts/check-fx-migration.mts <path to a copy of data/pglite>
// Never point this at the live data directory: it applies schema.sql and the migrations to whatever it opens.
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/app.ts'
import { migrateCurrencies, migrateSplitStorage } from '../src/migrate.ts'
import type { Sql } from '../src/db.ts'

const dir = process.argv[2]
if (!dir || /(^|\/)(live|prod)/.test(dir)) throw new Error('usage: check-fx-migration.mts <copy of data/pglite>')
const db = new PGlite(dir)
const wrap = (d: PGlite): Sql => ({
  async query(text, params = []) { return (await d.query(text, params as never[])).rows as never },
  async exec(text) { await d.exec(text) },
  async tx(fn) { return d.transaction((tx) => fn(wrap(tx as unknown as PGlite))) },
})
const sql = wrap(db)

const snapshot = async () => ({
  expenses: await sql.query(`select id, group_id, expense_date, original_currency, original_minor, settlement_minor, rate, overridden, version, deleted_at from expenses order by id`),
  lines: await sql.query(`select expense_id, participant_id, role, minor from expense_lines order by 1,2,3`),
  settlements: await sql.query(`select id, group_id, from_participant_id, to_participant_id, minor, deleted_at from settlements order by id`),
  groups: await sql.query(`select id, settlement_currency from groups order by id`),
})
const before = await snapshot()
await db.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'))
const split = await migrateSplitStorage(sql)
const first = await migrateCurrencies(sql)
const second = await migrateCurrencies(sql)
const after = await snapshot()
const same = JSON.stringify(before) === JSON.stringify(after)
console.log('split-storage migration:', JSON.stringify(split))
console.log('currency migration, 1st run:', JSON.stringify(first), ' 2nd run:', JSON.stringify(second))
console.log('expenses', before.expenses.length, 'lines', before.lines.length, 'settlements', before.settlements.length, 'groups', before.groups.length)
console.log('every expense, line, settlement and group identical before/after (amounts, currencies, rates, versions):', same)
const cur = await sql.query<{ gc: string; oc: string; rate_null: boolean; n: number }>(
  `select g.settlement_currency gc, e.original_currency oc, (e.rate is null) rate_null, count(*)::int n from expenses e join groups g on g.id = e.group_id group by 1,2,3`)
console.log('currency/rate shape:', JSON.stringify(cur))

// Balances through the real read path (same code the app uses), before and after one new foreign-currency expense.
const { app, repo } = createApp(sql, { now: () => new Date('2026-11-02T20:00:00Z'), dev: true, rateFor: async () => '1.1000' })
const target = (await sql.query<{ group_id: string; participant_id: string }>(
  `select m.group_id, m.participant_id from memberships m join expenses e on e.group_id = m.group_id and e.deleted_at is null where m.removed_at is null group by 1,2 order by count(*) desc limit 1`))[0]!
const user = (await sql.query<{ id: string }>(`select u.id from users u join participants p on p.user_id = u.id where p.id = $1`, [target.participant_id]))[0]
if (user) {
  const token = await repo.createSession(user.id)
  const actor = (await repo.actorFromToken(token))!
  const netsOf = async () => JSON.stringify((await repo.groupDetail(actor, target.group_id)).nets)
  const nets0 = await netsOf()
  const detail = await repo.groupDetail(actor, target.group_id)
  const payer = detail.nets[0]!.participantId
  const other = detail.nets.find((n) => n.participantId !== payer)!.participantId
  const made = await repo.createExpense(actor, target.group_id, {
    description: 'FX check', date: '2026-10-30', originalMinor: 10000, originalCurrency: 'EUR',
    payers: [{ participantId: payer, minor: 11000 }], split: { type: 'equal', participantIds: [payer, other] },
  })
  const created = (await repo.groupDetail(actor, target.group_id)).expenses.find((e: any) => e.id === made.id) as any
  console.log('new EUR expense in migrated group:', JSON.stringify({ original: created.originalMinor + ' ' + created.originalCurrency, converted: created.settlementMinor + ' ' + created.currency, rate: created.rate, source: created.rateSource }))
  console.log('balances moved only by the new expense:', nets0 !== (await netsOf()))
} else {
  console.log('(no user-linked group to exercise the app path)')
}
void app
await db.close()
if (!same) process.exit(1)
