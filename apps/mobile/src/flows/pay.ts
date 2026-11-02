// Settle-up payment links: which buttons to show, what each says, and when to ask "did you send it?".
// Divvy never moves money and never learns the outcome: the only thing that records a payment is the person tapping Record.
import { PAY_LABELS, PAY_PROVIDERS, formatMoney, payLinksFor, payNote, providerSupports, type PayHandles, type PayProvider } from '@divvy/domain'

/** Coloured initial squares, not brand logos. */
export const PAY_TILE: Record<PayProvider, { initial: string; color: string }> = {
  venmo: { initial: 'V', color: '#3d95ce' },
  paypal: { initial: 'P', color: '#003087' },
  cashapp: { initial: '$', color: '#00a63e' },
}

export type PayRow = { provider: PayProvider; label: string; handleText: string; sub: string; url: string; opensWith: string }
export type PayRows = {
  rows: PayRow[]
  /** Apps this currency allows that the payee hasn't set up, in display order. */
  missing: PayProvider[]
  /** True when the payee has set up none of the apps this currency allows. */
  nothing: boolean
}

export function handleText(provider: PayProvider, handle: string): string {
  return provider === 'venmo' ? `@${handle}` : provider === 'paypal' ? `paypal.me/${handle}` : `$${handle}`
}

/** Buttons for paying `minor` of `currency` to someone with these handles. No amount to pay (zero, or a typo) means no buttons. */
export function payRowsFor(handles: PayHandles | null | undefined, minor: number, currency: string, groupName: string): PayRows {
  const allowed = PAY_PROVIDERS.filter((provider) => providerSupports(provider, currency))
  const links = payLinksFor(handles, minor, currency, payNote(groupName))
  const rows = links.map((link): PayRow => {
    const handle = handles?.[link.provider] ?? ''
    const money = formatMoney(minor, currency)
    return {
      provider: link.provider,
      label: PAY_LABELS[link.provider],
      handleText: handleText(link.provider, handle),
      sub: `${handleText(link.provider, handle)} · opens ${link.provider === 'venmo' && link.noteIncluded ? `Venmo with ${money} filled in` : `with ${money}`}`,
      url: link.url,
      opensWith: money,
    }
  })
  const have = new Set((handles ? PAY_PROVIDERS.filter((provider) => handles[provider]) : []))
  const missing = allowed.filter((provider) => !have.has(provider))
  return { rows, missing, nothing: allowed.every((provider) => !have.has(provider)) }
}

/** A link that has been opened and not yet answered. Lives in memory only: closing the app forgets it. */
export type PendingPay = {
  provider: PayProvider; groupId: string; fromId: string; toId: string; payeeName: string; minor: number; currency: string
  openedAt: number
  /** The app has actually gone to the background since the link was opened (a system "open in…" prompt that was cancelled doesn't count). */
  left: boolean
}

const MIN_AWAY_MS = 1500
const FORGET_AFTER_MS = 6 * 60 * 60 * 1000

/** What to do when the app comes back to the foreground. Only a real trip away (backgrounded, 1.5 s or more) gets the question. */
export function onReturn(pending: PendingPay | null, now: number): 'ask' | 'wait' | 'forget' {
  if (!pending) return 'forget'
  const away = now - pending.openedAt
  if (away > FORGET_AFTER_MS) return 'forget'
  return pending.left && away >= MIN_AWAY_MS ? 'ask' : 'wait'
}

/** Only ask about a payment that is still owed, for no more than what is owed. */
export function stillOwed(payments: { fromId: string; toId: string; minor: number }[], pending: Pick<PendingPay, 'fromId' | 'toId' | 'minor'>): boolean {
  const owed = payments.find((p) => p.fromId === pending.fromId && p.toId === pending.toId)
  return !!owed && pending.minor > 0 && pending.minor <= owed.minor
}

/** Never says "paid" or "confirmed": Divvy can't see what happened in the other app. */
export function returnQuestion(payeeName: string, minor: number, currency: string, provider: PayProvider): string {
  return `Did you send ${payeeName} ${formatMoney(minor, currency)} on ${PAY_LABELS[provider]}?`
}
export const RETURN_HINT = 'Divvy can’t see what happened in the app. Only record it if the payment went through.'
