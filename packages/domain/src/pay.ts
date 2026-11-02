// Payment links. Divvy never moves money: it only builds a link that opens Venmo, PayPal or Cash App with the person and the
// amount filled in, and the payer still taps "Record" in Divvy afterwards. Handles are what people type into their Account.
import { exponentOf, LedgerError } from './money.ts'

export const PAY_PROVIDERS = ['venmo', 'paypal', 'cashapp'] as const
export type PayProvider = (typeof PAY_PROVIDERS)[number]
/** A person's saved handles, already normalized. A missing key means none saved. */
export type PayHandles = Partial<Record<PayProvider, string>>

export const PAY_LABELS: Record<PayProvider, string> = { venmo: 'Venmo', paypal: 'PayPal', cashapp: 'Cash App' }
/** What the Account field is called, and the hint shown under it. */
export const PAY_FIELD: Record<PayProvider, { label: string; placeholder: string; hint: string }> = {
  venmo: { label: 'Venmo username', placeholder: 'your-username', hint: '5–30 letters, numbers, - or _' },
  paypal: { label: 'PayPal.me name', placeholder: 'yourname', hint: 'The name in paypal.me/yourname · letters and numbers' },
  cashapp: { label: 'Cash App $cashtag', placeholder: 'cashtag', hint: 'Without the $ · letters, numbers or _' },
}

type Check = { ok: true; value: string | null } | { ok: false; message: string }

const PATTERNS: Record<PayProvider, RegExp> = {
  venmo: /^[A-Za-z0-9_-]{5,30}$/,
  paypal: /^[A-Za-z0-9]{1,20}$/,
  cashapp: /^(?=.*[A-Za-z])[A-Za-z0-9_]{1,20}$/,
}
const MESSAGES: Record<PayProvider, string> = {
  venmo: 'A Venmo username is 5–30 letters, numbers, hyphens or underscores.',
  paypal: 'A PayPal.me name is up to 20 letters and numbers.',
  cashapp: 'A $cashtag is up to 20 letters, numbers or underscores, with at least one letter.',
}

/** People paste whole links or type the @ / $ sign: take the handle out of those. */
function stripDecor(provider: PayProvider, text: string): string {
  let value = text.trim()
  const link = value.match(/^(?:https?:\/\/)?(?:www\.|account\.)?(?:venmo\.com|paypal\.me|paypal\.com\/paypalme|cash\.app)\/(.*)$/i)
  if (link) {
    value = (link[1] ?? '').split(/[?#]/)[0]!.replace(/\/+$/, '')
    if (provider === 'venmo') value = value.replace(/^u\//i, '')
    value = decodeURIComponent(value.split('/')[0] ?? '')
  }
  if (provider === 'venmo') value = value.replace(/^@/, '')
  if (provider === 'cashapp') value = value.replace(/^\$/, '')
  return value.trim()
}

/** Empty input clears the handle (value null). Otherwise the handle with its sign or link stripped, or why it is not valid. */
export function checkHandle(provider: PayProvider, input: unknown): Check {
  if (input === null || input === undefined) return { ok: true, value: null }
  if (typeof input !== 'string') return { ok: false, message: MESSAGES[provider] }
  if (input.trim() === '') return { ok: true, value: null }
  if (input.length > 200) return { ok: false, message: MESSAGES[provider] }
  let value: string
  try { value = stripDecor(provider, input) } catch { return { ok: false, message: MESSAGES[provider] } }
  return PATTERNS[provider].test(value) ? { ok: true, value } : { ok: false, message: MESSAGES[provider] }
}

/** Same check, throwing the error the API sends back. */
export function assertHandle(provider: PayProvider, input: unknown): string | null {
  const checked = checkHandle(provider, input)
  if (!checked.ok) throw new LedgerError('BAD_HANDLE', checked.message)
  return checked.value
}

/** Venmo and Cash App only work in US dollars. PayPal.me takes an amount with a currency code. */
export function providerSupports(provider: PayProvider, currency: string): boolean {
  const code = currency.toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return false
  return provider === 'paypal' ? true : code === 'USD'
}

/** Whole minor units as the plain decimal a payment form wants: 4250 → "42.50", JPY 500 → "500". */
export function payAmountText(minor: number, currency: string): string {
  if (!Number.isInteger(minor) || minor < 0) throw new LedgerError('BAD_AMOUNT', 'Amount must be a whole number of minor units')
  const exponent = exponentOf(currency)
  if (exponent === 0) return String(minor)
  const unit = 10 ** exponent
  return `${Math.floor(minor / unit)}.${String(minor % unit).padStart(exponent, '0')}`
}

/** The note that goes with a payment where the app can take one. */
export function payNote(groupName: string): string {
  const name = groupName.replace(/\s+/g, ' ').trim().slice(0, 60)
  return name ? `Divvy: ${name}` : 'Divvy'
}

export type PayLink = { provider: PayProvider; url: string; amount: string; noteIncluded: boolean }

/**
 * The link for one provider, or null when it can't be built: no valid handle, a currency the app doesn't take, or nothing to pay.
 * Venmo uses its web pay page (the venmo:// scheme stopped pre-filling), which opens the app when it is installed.
 * PayPal.me has no note field; Cash App's link has none that is documented.
 */
export function buildPayLink(provider: PayProvider, handle: string | null | undefined, minor: number, currency: string, note?: string): PayLink | null {
  if (!handle || !providerSupports(provider, currency)) return null
  if (!Number.isInteger(minor) || minor <= 0) return null
  const checked = checkHandle(provider, handle)
  if (!checked.ok || !checked.value) return null
  const clean = checked.value
  const amount = payAmountText(minor, currency)
  if (provider === 'venmo') {
    const noteText = note?.trim() ? `&note=${encodeURIComponent(note.trim())}` : ''
    return { provider, amount, noteIncluded: noteText !== '', url: `https://account.venmo.com/pay?txn=pay&recipients=%2C${encodeURIComponent(clean)}&amount=${amount}${noteText}&audience=private` }
  }
  if (provider === 'paypal') {
    return { provider, amount, noteIncluded: false, url: `https://paypal.me/${encodeURIComponent(clean)}/${amount}${currency.toUpperCase()}` }
  }
  return { provider, amount, noteIncluded: false, url: `https://cash.app/$${encodeURIComponent(clean)}/${amount}` }
}

/** Every provider the payee has a handle for and that takes this currency, in the order Venmo, PayPal, Cash App. */
export function payLinksFor(handles: PayHandles | null | undefined, minor: number, currency: string, note?: string): PayLink[] {
  if (!handles) return []
  return PAY_PROVIDERS.flatMap((provider) => {
    const link = buildPayLink(provider, handles[provider], minor, currency, note)
    return link ? [link] : []
  })
}
