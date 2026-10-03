import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXED_CATEGORIES } from '@divvy/domain'

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

export type Sql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  exec(text: string): Promise<void>
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>
}

async function seedCategories(sql: Sql) {
  for (const category of FIXED_CATEGORIES) {
    await sql.query(
      `insert into categories (id, group_id, label, fixed) values ($1, null, $2, true)
       on conflict (id) do nothing`,
      [category.id, category.label],
    )
  }
}

export async function createMemorySql(): Promise<Sql> {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  await db.exec(schema)
  const sql = wrapPglite(db)
  await seedCategories(sql)
  return sql
}

export async function createSql(): Promise<Sql> {
  if (process.env.DATABASE_URL) {
    const postgres = (await import('postgres')).default
    const client = postgres(process.env.DATABASE_URL, { max: 10 })
    const sql = wrapPostgres(client as unknown as Parameters<typeof wrapPostgres>[0])
    await sql.exec(schema)
    await seedCategories(sql)
    return sql
  }
  const { PGlite } = await import('@electric-sql/pglite')
  const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/pglite')
  const db = new PGlite(dataDir)
  await db.exec(schema)
  const sql = wrapPglite(db)
  await seedCategories(sql)
  return sql
}

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  exec?: (text: string) => Promise<unknown>
  transaction?: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>
}

function wrapPglite(db: Queryable): Sql {
  const wrap = (queryable: Queryable, nested: boolean): Sql => ({
    async query(text, params = []) {
      const result = await queryable.query(text, params)
      return (result.rows ?? result) as never
    },
    async exec(text) {
      if (!queryable.exec) throw new Error('This connection cannot run scripts')
      await queryable.exec(text)
    },
    async tx(fn) {
      if (nested || !db.transaction) throw new Error('Nested transactions are not supported')
      return db.transaction((tx) => fn(wrap(tx, true)))
    },
  })
  return wrap(db, false)
}

function wrapPostgres(client: {
  unsafe: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
  begin: <T>(fn: (tx: { unsafe: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]> }) => Promise<T>) => Promise<T>
}): Sql {
  const wrap = (unsafe: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>, nested: boolean): Sql => ({
    query: (text, params = []) => unsafe(text, params) as Promise<never>,
    async exec(text) {
      await unsafe(text)
    },
    tx(fn) {
      if (nested) throw new Error('Nested transactions are not supported')
      return client.begin((tx) => fn(wrap(tx.unsafe.bind(tx), true)))
    },
  })
  return wrap(client.unsafe.bind(client), false)
}
