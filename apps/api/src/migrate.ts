import { randomUUID } from 'node:crypto'
import type { Sql } from './db.ts'

/**
 * Design v2 data migration. Safe to run on every start (it only touches rows that still need it):
 *  - every expense without a split_method gets one, inferred from its stored share lines;
 *  - every expense without history gets a "created" row (plus its edits/deletes) rebuilt from the activity feed.
 * Share amounts are already integer minor units, so no amount is ever changed here.
 */
export async function migrateSplitStorage(sql: Sql): Promise<{ methods: number; history: number }> {
  const methods = await backfillSplitMethods(sql)
  const history = await backfillHistory(sql)
  return { methods, history }
}

type Line = { participant_id: string; minor: number }

/** How a legacy set of share lines was most likely entered. Exposed for tests. */
export function inferSplit(shares: Line[], itemized: boolean): { method: 'equal' | 'exact'; inputs: unknown } {
  const amounts = shares.map((line) => line.minor)
  if (!itemized && amounts.length > 0 && Math.max(...amounts) - Math.min(...amounts) <= 1) {
    return { method: 'equal', inputs: { participantIds: shares.map((line) => line.participant_id) } }
  }
  return { method: 'exact', inputs: { amounts: shares.map((line) => ({ participantId: line.participant_id, minor: line.minor })) } }
}

async function backfillSplitMethods(sql: Sql): Promise<number> {
  const rows = await sql.query<{ id: string }>(`select id from expenses where split_method is null`)
  if (rows.length === 0) return 0
  const lines = await sql.query<{ expense_id: string; participant_id: string; minor: number }>(
    `select el.expense_id, el.participant_id, el.minor from expense_lines el
     join expenses e on e.id = el.expense_id where e.split_method is null and el.role = 'share'
     order by el.expense_id, el.participant_id`,
  )
  const itemized = new Set((await sql.query<{ expense_id: string }>(
    `select distinct i.expense_id from expense_items i join expenses e on e.id = i.expense_id where e.split_method is null`,
  )).map((row) => row.expense_id))
  const byExpense = new Map<string, Line[]>()
  for (const line of lines) {
    const list = byExpense.get(line.expense_id) ?? []
    list.push({ participant_id: line.participant_id, minor: Number(line.minor) })
    byExpense.set(line.expense_id, list)
  }
  await sql.tx(async (tx) => {
    for (const row of rows) {
      const inferred = inferSplit(byExpense.get(row.id) ?? [], itemized.has(row.id))
      await tx.query(`update expenses set split_method = $1, split_inputs = $2 where id = $3 and split_method is null`, [
        inferred.method,
        JSON.stringify(inferred.inputs),
        row.id,
      ])
    }
  })
  return rows.length
}

const HISTORY_KINDS: Record<string, string> = {
  'expense.created': 'created',
  'expense.updated': 'edited',
  'expense.deleted': 'deleted',
  'expense.restored': 'restored',
}

async function backfillHistory(sql: Sql): Promise<number> {
  const bare = await sql.query<{ id: string; created_at: string }>(
    `select e.id, e.created_at from expenses e where not exists (select 1 from expense_history h where h.expense_id = e.id)`,
  )
  if (bare.length === 0) return 0
  const events = await sql.query<{ actor_participant_id: string | null; kind: string; payload: string; created_at: string }>(
    `select actor_participant_id, kind, payload, created_at from activity
     where kind in ('expense.created','expense.updated','expense.deleted','expense.restored') order by created_at, id`,
  )
  const byExpense = new Map<string, typeof events>()
  for (const event of events) {
    let expenseId: unknown
    try { expenseId = (JSON.parse(event.payload) as { expenseId?: unknown }).expenseId } catch { continue }
    if (typeof expenseId !== 'string') continue
    const list = byExpense.get(expenseId) ?? []
    list.push(event)
    byExpense.set(expenseId, list)
  }
  let written = 0
  await sql.tx(async (tx) => {
    for (const expense of bare) {
      const own = byExpense.get(expense.id) ?? []
      const rows: { actor: string | null; kind: string; at: unknown }[] = own.map((event) => ({
        actor: event.actor_participant_id,
        kind: HISTORY_KINDS[event.kind]!,
        at: event.created_at,
      }))
      if (!rows.some((row) => row.kind === 'created')) {
        rows.unshift({ actor: null, kind: 'created', at: expense.created_at })
      }
      for (const row of rows) {
        await tx.query(
          `insert into expense_history (id, expense_id, actor_participant_id, kind, changes, created_at) values ($1,$2,$3,$4,null,$5)`,
          [randomUUID(), expense.id, row.actor, row.kind, row.at],
        )
        written += 1
      }
    }
  })
  return written
}
