// The Activity feed: what happened to expenses and payments, who did it, how much, and when.
// The API reads the `activity` log (enriched with expense history) and builds entries here; the app renders them.
import { LedgerError, formatMoney } from './money.ts'

/** Every activity kind that appears in the feed. Group admin events (created, archived, joined…) stay out of it. */
export const FEED_KINDS = [
  'expense.created',
  'expense.updated',
  'expense.deleted',
  'expense.restored',
  'expense.moved',
  'settlement.created',
  'settlement.deleted',
  'settlement.restored',
  'settlement.moved',
] as const
export type FeedKind = (typeof FEED_KINDS)[number]

export function isFeedKind(kind: string): kind is FeedKind {
  return (FEED_KINDS as readonly string[]).includes(kind)
}

export type FeedChange = { field: string; from: unknown; to: unknown }
export type FeedPerson = { id: string | null; name: string | null }

export type FeedEntry = {
  id: string
  kind: FeedKind
  /** ISO time, millisecond precision. */
  at: string
  actor: FeedPerson
  group: { id: string; name: string; emoji: string | null; currency: string }
  target: {
    type: 'expense' | 'settlement'
    id: string | null
    /** Expense description, blank when it has none. Empty for settlements. */
    label: string
    /** True when the expense or payment still counts toward balances (not deleted or undone). */
    live: boolean
  }
  /** What was added, edited, deleted or paid, in the group's currency. Null only when nothing recorded it. */
  amountMinor: number | null
  /** On an edit that changed the amount: what it was before. */
  previousAmountMinor: number | null
  currency: string
  /** Payments: who paid whom. */
  from: FeedPerson | null
  to: FeedPerson | null
  /** Edits: what changed (from the expense history), null for older edits that did not record it. */
  changes: FeedChange[] | null
  /** Moves: whether it left this group or arrived in it. */
  direction: 'in' | 'out' | null
  /** True for the two ways to take something back: restoring a deleted expense, and undoing a recorded payment. */
  undo: boolean
}

export type FeedPage = { items: FeedEntry[]; nextCursor: string | null }

/** One row of the activity log, with its JSON payload already parsed. */
export type RawActivity = {
  id: string
  kind: string
  summary: string
  payload: unknown
  at: string
  actor: FeedPerson
}

/** What the API could look up about the thing the row is about, as it is now. */
export type FeedContext = {
  group: FeedEntry['group']
  expense?: { id: string; description: string; settlementMinor: number; deleted: boolean } | null
  settlement?: { id: string; from: FeedPerson; to: FeedPerson; minor: number; deleted: boolean } | null
  /** The edit-history `changes` for this row, when it is an edit and they were recorded. */
  changes?: FeedChange[] | null
}

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const int = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Build one feed entry. Newer rows carry their amounts and names in the payload; older ones are filled in from what exists now. */
export function buildFeedEntry(row: RawActivity, ctx: FeedContext): FeedEntry | null {
  if (!isFeedKind(row.kind)) return null
  const kind = row.kind
  const payload = obj(row.payload)
  const isExpense = kind.startsWith('expense.')
  const changes = ctx.changes ?? null
  const changeOf = (field: string) => changes?.find((change) => change.field === field)

  let amount: number | null = null
  let previous: number | null = null
  let label = ''
  if (isExpense) {
    const current = ctx.expense ?? null
    label = (str(payload.description) ?? current?.description ?? '').trim()
    if (kind === 'expense.updated') {
      const before = int(obj(payload.previous).settlementMinor)
      const amountChange = changeOf('amount')
      amount = int(payload.settlementMinor) ?? int(amountChange?.to)
      if (amount === null && before !== null && changes !== null) amount = before
      if (amount === null) amount = current?.settlementMinor ?? null
      previous = int(amountChange?.from) ?? before
      if (previous === amount) previous = null
      const descriptionChange = changeOf('description')
      if (!str(payload.description) && typeof descriptionChange?.to === 'string') label = descriptionChange.to.trim()
    } else {
      amount = int(payload.settlementMinor) ?? current?.settlementMinor ?? null
    }
  } else {
    amount = int(payload.minor) ?? ctx.settlement?.minor ?? null
  }

  const settlement = ctx.settlement ?? null
  const fromId = str(payload.fromId)
  const toId = str(payload.toId)
  const from: FeedPerson | null = isExpense ? null : { id: fromId ?? settlement?.from.id ?? null, name: settlement?.from.name ?? null }
  const to: FeedPerson | null = isExpense ? null : { id: toId ?? settlement?.to.id ?? null, name: settlement?.to.name ?? null }

  let direction: 'in' | 'out' | null = null
  if (kind.endsWith('.moved')) {
    const stored = payload.direction
    direction = stored === 'in' || stored === 'out' ? stored : / in$/.test(row.summary) ? 'in' : / out$/.test(row.summary) ? 'out' : null
  }

  const targetId = str(payload[isExpense ? 'expenseId' : 'settlementId'])
  return {
    id: row.id,
    kind,
    at: row.at,
    actor: row.actor,
    group: ctx.group,
    target: {
      type: isExpense ? 'expense' : 'settlement',
      id: targetId,
      label,
      live: isExpense ? ctx.expense != null && !ctx.expense.deleted : ctx.settlement != null && !ctx.settlement.deleted,
    },
    amountMinor: amount,
    previousAmountMinor: previous,
    currency: ctx.group.currency,
    from,
    to,
    changes,
    direction,
    undo: kind === 'expense.restored' || kind === 'settlement.deleted',
  }
}

export type FeedTone = 'add' | 'edit' | 'delete' | 'undo' | 'settle' | 'move'

export function feedTone(entry: Pick<FeedEntry, 'kind'>): FeedTone {
  switch (entry.kind) {
    case 'expense.created': return 'add'
    case 'expense.updated': return 'edit'
    case 'expense.deleted': return 'delete'
    case 'expense.restored':
    case 'settlement.deleted':
    case 'settlement.restored': return 'undo'
    case 'settlement.created': return 'settle'
    default: return 'move'
  }
}

const nameOf = (person: FeedPerson | null, youId: string | null, you: string) => (person?.id && person.id === youId ? you : person?.name?.trim() || 'Someone')

/** "You added “Dinner”", "Sam edited “Dinner”", "Sam paid you", "Maya undid a payment (You paid Sam)". */
export function feedSentence(entry: FeedEntry, youId: string | null): string {
  const who = nameOf(entry.actor, youId, 'You')
  const thing = entry.target.label ? `“${entry.target.label}”` : 'an expense'
  const way = entry.direction === 'in' ? ' in' : entry.direction === 'out' ? ' out' : ''
  if (entry.target.type === 'expense') {
    switch (entry.kind) {
      case 'expense.created': return `${who} added ${thing}`
      case 'expense.updated': return `${who} edited ${thing}`
      case 'expense.deleted': return `${who} deleted ${thing}`
      case 'expense.restored': return `${who} restored ${thing}`
      default: return `${who} moved ${thing}${way}`
    }
  }
  const known = !!(entry.from?.id || entry.from?.name) && !!(entry.to?.id || entry.to?.name)
  const payment = known ? paymentPhrase(entry, youId) : null
  switch (entry.kind) {
    case 'settlement.created': {
      if (!payment) return `${who} recorded a payment`
      return entry.actor.id && entry.actor.id === entry.from?.id ? payment : `${payment} (recorded by ${who})`
    }
    case 'settlement.deleted': return payment ? `${who} undid a payment (${payment})` : `${who} undid a payment`
    case 'settlement.restored': return payment ? `${who} restored a payment (${payment})` : `${who} restored a payment`
    default: return `${who} moved a payment${way}`
  }
}

function paymentPhrase(entry: FeedEntry, youId: string | null) {
  const payer = nameOf(entry.from, youId, 'You')
  const payee = nameOf(entry.to, youId, 'you')
  return `${payer} paid ${payee}`
}

/** The amount line: "$40.00", or "$40.00 (was $35.00)" for an edit that changed the amount. Null when there is none. */
export function feedAmountText(entry: FeedEntry): string | null {
  if (entry.amountMinor === null) return null
  const now = formatMoney(entry.amountMinor, entry.currency)
  if (entry.kind === 'expense.updated' && entry.previousAmountMinor !== null) return `${now} (was ${formatMoney(entry.previousAmountMinor, entry.currency)})`
  return now
}

// ─── Pagination ───

export const FEED_PAGE_DEFAULT = 30
export const FEED_PAGE_MAX = 100

export function clampFeedLimit(raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return FEED_PAGE_DEFAULT
  return Math.min(FEED_PAGE_MAX, Math.max(1, Math.floor(n)))
}

/** A cursor is the sort key of the last row seen: its exact timestamp (microseconds) and id. Opaque to clients. */
export type FeedCursor = { at: string; id: string }
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([A-Za-z0-9_-]{1,64})$/

export function encodeFeedCursor(cursor: FeedCursor): string {
  return `${cursor.at}|${cursor.id}`
}

export function decodeFeedCursor(raw: string | null | undefined): FeedCursor | null {
  if (raw === undefined || raw === null || raw === '') return null
  const match = CURSOR.exec(raw)
  if (!match || Number.isNaN(Date.parse(match[1]!))) throw new LedgerError('BAD_CURSOR', 'That page marker is not valid. Reload the feed.')
  return { at: match[1]!, id: match[2]! }
}
