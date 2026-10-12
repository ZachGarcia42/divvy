import { codeOf, isNetwork } from './errors'

// Same rule as the API's normalizeEmail, so a bad address never leaves the phone.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const LAST_EMAIL_KEY = 'divvy.lastEmail'
export const RESEND_COOLDOWN_MS = 30_000
export const SENT_AGAIN_MS = 2_500

export function normalizeEmail(text: string) {
  return text.trim().toLowerCase()
}

export function emailError(text: string) {
  return EMAIL.test(normalizeEmail(text)) ? null : 'Enter a valid email'
}

/** Copy for a failed Send link / Resend. Never pretends the link went out. */
export function sendErrorMessage(reason: unknown) {
  const code = codeOf(reason)
  if (code === 'RATE_LIMITED') return 'That’s a lot of links. Wait a few minutes, then try again.'
  if (code === 'BAD_EMAIL') return 'Enter a valid email'
  if (isNetwork(reason) || !code) return 'Couldn’t send the link. Check your signal and try again.'
  return reason instanceof Error ? reason.message : 'Couldn’t send the link. Try again.'
}

/** Copy for a failed verify of a tapped link (1e/1f). */
export function verifyFailure(reason: unknown): { kind: 'expired' } | { kind: 'error'; message: string } {
  if (codeOf(reason) === 'BAD_TOKEN') return { kind: 'expired' }
  if (isNetwork(reason)) return { kind: 'error', message: 'Couldn’t reach Divvy. Check your signal and tap the link again.' }
  return { kind: 'error', message: reason instanceof Error ? reason.message : 'Couldn’t sign you in.' }
}

/** The Resend button on Check your email: "Sent again" briefly, then a 30 s cooldown. */
export function resendButton(state: { sentAt: number | null; resentAt: number | null; sending: boolean }, now: number) {
  if (state.sending) return { label: 'Sending…', disabled: true }
  if (state.resentAt !== null && now - state.resentAt < SENT_AGAIN_MS) return { label: 'Sent again', disabled: true }
  const last = Math.max(state.sentAt ?? -Infinity, state.resentAt ?? -Infinity)
  const left = Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000)
  if (Number.isFinite(last) && left > 0) return { label: `Resend in ${left} s`, disabled: true }
  return { label: 'Resend link', disabled: false }
}
