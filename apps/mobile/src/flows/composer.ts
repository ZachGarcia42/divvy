// Pure helpers for the expense composer and group card (kept out of App.tsx so they can be unit-tested).
import { parseMajor, shareGapMessage } from '@divvy/domain'

/** One custom share as minor units. Blank counts as 0 so the add-up check reports what's left. */
export function parseShare(input: string, currency: string) {
  const trimmed = input.trim()
  if (!trimmed) return 0
  if (/^0+(\.0+)?$/.test(trimmed)) return 0
  return parseMajor(trimmed, currency)
}

/**
 * The live "Shares have to add up… $x left/over" line, computed from the current amount and share
 * text on every render (both converted to minor units the same way). null when balanced or not computable.
 */
export function liveShareGap(amount: string, shares: Record<string, string | undefined>, memberIds: string[], currency: string): string | null {
  let total: number
  try { total = parseMajor(amount, currency) } catch { return null }
  let sum = 0
  for (const id of memberIds) {
    try { sum += parseShare(shares[id] ?? '', currency) } catch { return null }
  }
  return shareGapMessage(sum, total, currency)
}

/** Shortens long text in the middle ("https://divvy…/invite/abc"), keeping both ends readable. */
export function middleEllipsis(text: string, max = 36) {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/** Which group to open after sign-in: the last one you had open if you're still in it, else the first open one. */
export function pickGroup(groups: { id: string; archived?: boolean }[], current: string | null, last: string | null) {
  if (current && groups.some((group) => group.id === current)) return current
  if (last && groups.some((group) => group.id === last)) return last
  return groups.find((group) => !group.archived)?.id ?? groups[0]?.id ?? null
}

/** What to say after accepting a group link: new members get a lasting "You're in" banner, existing ones just a toast. */
export function joinedFeedback(groupName: string, alreadyMember: boolean) {
  return alreadyMember
    ? { toast: `You’re already in ${groupName}.`, banner: null }
    : { toast: `You’re in ${groupName}`, banner: `You’re in ${groupName}` }
}
