// Design v2 read-side helpers: groups home nets, group names with an emoji, expense rows, date groups, history lines.
import { formatMoney } from '@divvy/domain'

export type HomeGroupLike = { id: string; name: string; currency: string; yourNetMinor: number; archived: boolean; members?: string[]; latest?: { date: string } | null }

export const DEFAULT_EMOJI = '👥'
const EMOJI_LEAD = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s+/u

/** Groups keep one name; a leading emoji ("🏔️ Tahoe cabin") is its icon. */
export function splitGroupName(name: string): { emoji: string; title: string } {
  const match = EMOJI_LEAD.exec(name)
  if (!match) return { emoji: DEFAULT_EMOJI, title: name }
  return { emoji: match[1]!, title: name.slice(match[0].length) }
}

/** The icon comes from the group's own emoji (template or picker); older groups fall back to a leading emoji in the name. */
export function groupIcon(group: { name: string; emoji?: string | null }): { emoji: string; title: string } {
  const parsed = splitGroupName(group.name)
  return group.emoji ? { emoji: group.emoji, title: parsed.title } : parsed
}

/** Offered by the create-group icon picker. */
export const PICKER_EMOJIS = ['🏔️', '🏠', '💑', '🍜', '✈️', '🏖️', '🎉', '🛒', '🚗', '⚽', '🎬', '🐶'] as const

export type NetTone = 'owed' | 'owe' | 'settled'
export function netTone(minor: number): NetTone { return minor > 0 ? 'owed' : minor < 0 ? 'owe' : 'settled' }
export const NET_WORDS: Record<NetTone, string> = { owed: 'you are owed', owe: 'you owe', settled: 'settled up' }

/**
 * The hero: your overall net across groups, in USD only (no conversion; other currencies are left out and
 * flagged). Archived groups do not count.
 */
export function overallUsd(groups: HomeGroupLike[]) {
  const live = groups.filter((group) => !group.archived)
  const usd = live.filter((group) => group.currency === 'USD')
  const owed = usd.reduce((acc, group) => acc + Math.max(0, group.yourNetMinor), 0)
  const owe = usd.reduce((acc, group) => acc + Math.max(0, -group.yourNetMinor), 0)
  return {
    net: owed - owe,
    owed,
    owe,
    groupCount: live.length,
    usdCount: usd.length,
    leftOut: live.length - usd.length,
  }
}

export function signedMoney(minor: number, currency = 'USD') {
  return `${minor > 0 ? '+' : minor < 0 ? '-' : ''}${formatMoney(Math.abs(minor), currency)}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parts(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
}
const dayNumber = (iso: string) => { const p = parts(iso); return p ? Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000) : NaN }

export function monthDay(iso: string) {
  const p = parts(iso)
  return p ? `${MONTHS[p.m - 1]} ${p.d}` : iso
}

/** "TODAY · OCT 27", "YESTERDAY · OCT 26", else "SAT · OCT 24". */
export function dateHeading(iso: string, todayIso: string) {
  const p = parts(iso)
  if (!p) return iso.toUpperCase()
  const gap = dayNumber(todayIso) - dayNumber(iso)
  const lead = gap === 0 ? 'Today' : gap === 1 ? 'Yesterday' : DAYS[p.dow]!
  return `${lead} · ${monthDay(iso)}`.toUpperCase()
}

/** "Updated today", "yesterday", else "Oct 22". */
export function updatedPhrase(iso: string | null | undefined, todayIso: string) {
  if (!iso) return 'no expenses yet'
  const gap = dayNumber(todayIso) - dayNumber(iso)
  if (gap === 0) return 'updated today'
  if (gap === 1) return 'yesterday'
  return monthDay(iso)
}

export function peopleCount(n: number) { return `${n} ${n === 1 ? 'person' : 'people'}` }

export type ExpenseLike = {
  id: string
  date: string
  createdAt?: string | null
  description: string
  settlementMinor: number
  splitMethod?: string
  payers: { participantId: string; name: string; minor: number }[]
  shares?: { participantId: string; name?: string; minor: number }[]
}

export const METHOD_PHRASE: Record<string, string> = {
  equal: 'split equally',
  exact: 'exact amounts',
  percent: 'by percent',
  shares: 'shares',
  adjust: 'adjusted',
}

export function methodPhrase(method: string | undefined) { return METHOD_PHRASE[method ?? ''] ?? 'custom split' }

/** What you paid minus your share: positive you lent, negative you borrowed. null when you are not in it. */
export function yourPosition(expense: ExpenseLike, youId: string): { kind: 'lent' | 'borrowed' | 'none'; minor: number } {
  const paid = expense.payers.filter((p) => p.participantId === youId).reduce((a, p) => a + p.minor, 0)
  const share = (expense.shares ?? []).filter((s) => s.participantId === youId).reduce((a, s) => a + s.minor, 0)
  const involved = paid > 0 || (expense.shares ?? []).some((s) => s.participantId === youId)
  if (!involved) return { kind: 'none', minor: 0 }
  const net = paid - share
  return net >= 0 ? { kind: 'lent', minor: net } : { kind: 'borrowed', minor: -net }
}

export function paidPhrase(expense: ExpenseLike, youId: string, currency: string) {
  const paying = expense.payers.filter((p) => p.minor > 0)
  const who = paying.length === 1
    ? (paying[0]!.participantId === youId ? 'You paid' : `${paying[0]!.name} paid`)
    : `${paying.map((p) => (p.participantId === youId ? 'You' : p.name)).join(', ')} paid`
  return `${who} ${formatMoney(expense.settlementMinor, currency)}`
}

const createdMs = (expense: { createdAt?: string | null }) => {
  const ms = expense.createdAt ? Date.parse(expense.createdAt) : NaN
  return Number.isFinite(ms) ? ms : 0
}

/** Newest first, grouped by date, each group newest first. */
export function groupByDate<T extends ExpenseLike>(expenses: T[], todayIso: string) {
  const sorted = [...expenses].sort((a, b) => b.date.localeCompare(a.date) || createdMs(b) - createdMs(a) || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1))
  const out: { date: string; heading: string; items: T[] }[] = []
  for (const expense of sorted) {
    const last = out[out.length - 1]
    if (last && last.date === expense.date) last.items.push(expense)
    else out.push({ date: expense.date, heading: dateHeading(expense.date, todayIso), items: [expense] })
  }
  return out
}

export type DetailRow = { id: string; name: string; paid: number; share: number; net: number; note: string }

/** Per-person breakdown for the expense detail: paid, share, and net (paid − share). */
export function breakdown(expense: ExpenseLike, nameOf: (id: string) => string, method: string, inputs: unknown): DetailRow[] {
  const ids: string[] = []
  for (const row of [...expense.payers, ...(expense.shares ?? [])]) if (!ids.includes(row.participantId)) ids.push(row.participantId)
  const weightOf = new Map<string, number>()
  const total = (() => {
    const list = (inputs as { parts?: { participantId: string; weight?: number; bps?: number }[] } | null)?.parts
    if (!Array.isArray(list)) return 0
    for (const part of list) weightOf.set(part.participantId, method === 'percent' ? (part.bps ?? 0) : (part.weight ?? 0))
    return [...weightOf.values()].reduce((a, b) => a + b, 0)
  })()
  return ids.map((id) => {
    const paid = expense.payers.filter((p) => p.participantId === id).reduce((a, p) => a + p.minor, 0)
    const share = (expense.shares ?? []).filter((s) => s.participantId === id).reduce((a, s) => a + s.minor, 0)
    let note = ''
    if (method === 'shares' && weightOf.has(id)) note = `${weightOf.get(id)} share${weightOf.get(id) === 1 ? '' : 's'} of ${total}`
    if (method === 'percent' && weightOf.has(id)) note = `${(weightOf.get(id)! / 100).toString()}%`
    return { id, name: nameOf(id), paid, share, net: paid - share, note }
  })
}

export type HistoryEntry = { id: string; kind: string; actorId: string | null; actorName: string | null; changes: { field: string; from: unknown; to: unknown }[] | null; at: string }

function describeChange(change: { field: string; from: unknown; to: unknown }, currency: string, nameOf: (id: string) => string) {
  switch (change.field) {
    case 'amount': return `the amount to ${formatMoney(Number(change.to), currency)}`
    case 'description': return change.to ? `the description to “${String(change.to)}”` : 'the description'
    case 'date': return `the date to ${monthDay(String(change.to))}`
    case 'category': return 'the category'
    case 'payer': return `who paid to ${((change.to as string[]) ?? []).map(nameOf).join(', ')}`
    case 'method': return `the split to ${methodPhrase(String(change.to))}`
    case 'split': return 'who owes what'
    default: return change.field
  }
}

/** One line per history row: "You added this", "You changed the split to shares". */
export function historyLines(history: HistoryEntry[], youId: string, currency: string, nameOf: (id: string) => string, timeText: (iso: string) => string) {
  return history.map((entry) => {
    const who = entry.actorId === youId ? 'You' : (entry.actorName ?? 'Someone')
    const verb = (() => {
      if (entry.kind === 'created') return 'added this'
      if (entry.kind === 'deleted') return 'deleted this'
      if (entry.kind === 'restored') return 'restored this'
      if (entry.kind === 'moved') return 'moved this'
      const changes = entry.changes ?? []
      // The split method already says it all when the amounts moved along with it.
      const shown = changes.some((c) => c.field === 'method') ? changes.filter((c) => c.field !== 'split') : changes
      if (shown.length === 0) return 'edited this'
      return `changed ${shown.map((c) => describeChange(c, currency, nameOf)).join(' and ')}`
    })()
    return { id: entry.id, text: `${who} ${verb}`, time: timeText(entry.at) }
  })
}

/** First screen after load: your last group if you are still in it, else the Groups list. */
export function startScreen(groups: { id: string; archived?: boolean }[], last: string | null): { screen: 'group' | 'groups'; groupId: string | null } {
  if (last && groups.some((group) => group.id === last && !group.archived)) return { screen: 'group', groupId: last }
  return { screen: 'groups', groupId: null }
}

/** How long an Undo snackbar stays up. */
export const SNACK_MS = 6000

/** A snackbar belongs to the screen (and group) it was raised for; it goes away when either changes. */
export const snackOwner = (screen: string, groupId: string | null) => `${screen}:${groupId ?? ''}`
export const snackStays = (owner: string | undefined, screen: string, groupId: string | null) => owner === snackOwner(screen, groupId)
