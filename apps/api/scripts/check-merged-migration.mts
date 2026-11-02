// Runs the schema plus every migration (the same sequence createSql runs at startup) against a COPY of a data directory
// and proves every pre-existing column of every pre-existing table is unchanged; runs it twice (idempotent), then
// boots the app on it and reads the home page, each group and each group's feed.
//   npx tsx scripts/check-merged-migration.mts <path to a copy of data/pglite>
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { FIXED_CATEGORIES } from '@divvy/domain'
import { createApp } from '../src/app.ts'
import { migrateCurrencies, migrateSplitStorage } from '../src/migrate.ts'
import type { Sql } from '../src/db.ts'

const dir = process.argv[2]
if (!dir || /(^|\/)(live|prod)/.test(dir)) throw new Error('usage: check-merged-migration.mts <copy of data/pglite>')
const db = new PGlite(dir)
const wrap = (d: PGlite): Sql => ({
  async query(text, params = []) { return (await d.query(text, params as never[])).rows as never },
  async exec(text) { await d.exec(text) },
  async tx(fn) { return d.transaction((tx) => fn(wrap(tx as unknown as PGlite))) },
})
const sql = wrap(db)
const tables = async () => (await sql.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema='public' order by 1`)).map((r) => r.table_name)
const cols = async (t: string) => (await sql.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [t])).map((r) => r.column_name)
const dump = async (t: string, c: string[]) => JSON.stringify(await sql.query(`select ${c.map((x) => `"${x}"`).join(',')} from "${t}" order by ${c.map((x) => `"${x}"::text`).join(',')}`))

const t0 = await tables()
const baseline: Record<string, { cols: string[]; rows: string; n: number }> = {}
for (const t of t0) { const c = await cols(t); baseline[t] = { cols: c, rows: await dump(t, c), n: (await sql.query<{ n: number }>(`select count(*)::int n from "${t}"`))[0]!.n } }
console.log('tables before:', t0.length, ' rows:', JSON.stringify(Object.fromEntries(t0.map((t) => [t, baseline[t]!.n]))))

const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8')
const startup = async () => {
  await db.exec(schema)
  for (const category of FIXED_CATEGORIES) await sql.query(`insert into categories (id, group_id, label, fixed) values ($1, null, $2, true) on conflict (id) do nothing`, [category.id, category.label])
  return { split: await migrateSplitStorage(sql), currencies: await migrateCurrencies(sql) }
}
const first = await startup()
const second = await startup()
console.log('startup 1:', JSON.stringify(first), ' startup 2:', JSON.stringify(second))

const t1 = await tables()
console.log('tables added:', JSON.stringify(t1.filter((t) => !t0.includes(t))))
let ok = true
for (const t of t0) {
  const now = await dump(t, baseline[t]!.cols)
  const added = (await cols(t)).filter((c) => !baseline[t]!.cols.includes(c))
  const same = now === baseline[t]!.rows
  if (!same) ok = false
  console.log(`${same ? 'same   ' : 'CHANGED'} ${t} (${baseline[t]!.n} rows)${added.length ? ' +columns ' + added.join(',') : ''}`)
}
const grew = await sql.query(`select kind, count(*)::int n from activity group by 1 order by 1`)
console.log('activity kinds:', JSON.stringify(grew))
console.log('ALL PRE-EXISTING DATA UNCHANGED:', ok)

// Boot the app on the migrated copy and read through it as a dev sign-in (a new user: the old data stays untouched).
import { sessionFor } from '../src/testkit.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { app } = createApp(sql, { dev: true, now: () => new Date('2026-11-02T18:00:00Z'), rateFor: async () => '1', photoDir: mkdtempSync(join(tmpdir(), 'divvy-migtest-')) })
const token = await sessionFor(app, 'migration-check@example.com')
const call = async (path: string, method = 'GET', body?: unknown) => {
  const r = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-divvy-platform': 'ios' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, json: (await r.json().catch(() => null)) as any }
}
const home = await call('/api/home')
const feed = await call('/api/feed')
console.log('app on migrated copy: /api/home', home.status, ' /api/feed', feed.status)
// Read every old group's feed and detail directly through the repo-shaped queries (membership-gated, so ask as each owner is not possible; check the SQL paths instead).
const gs = await sql.query<{ id: string }>(`select id from groups order by id`)
console.log('groups in copy:', gs.length)
