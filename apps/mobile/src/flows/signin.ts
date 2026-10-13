import { codeOf, isNetwork, isTransient } from './errors'

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

const OFFLINE = 'Couldn’t send the link. Check your signal and try again.'

/** Copy for a failed Send link / Resend. Never pretends the link went out, never shows a name error. */
export function sendErrorMessage(reason: unknown) {
  const code = codeOf(reason)
  if (code === 'RATE_LIMITED') return 'That’s a lot of links. Wait a few minutes, then try again.'
  if (code === 'BAD_EMAIL') return 'Enter a valid email'
  if (isTransient(reason) || !code || code.startsWith('HTTP_') || code === 'BAD_NAME') return OFFLINE
  return reason instanceof Error && reason.message !== 'Request failed' ? reason.message : OFFLINE
}

/** Copy for a failed verify of a tapped link (1e/1f). */
export function verifyFailure(reason: unknown): { kind: 'expired' } | { kind: 'error'; message: string } {
  if (codeOf(reason) === 'BAD_TOKEN') return { kind: 'expired' }
  if (isTransient(reason) || codeOf(reason) === 'BAD_NAME' || codeOf(reason)?.startsWith('HTTP_')) {
    return { kind: 'error', message: 'Couldn’t reach Divvy. Check your signal and tap the link again.' }
  }
  return { kind: 'error', message: reason instanceof Error && reason.message !== 'Request failed' ? reason.message : 'Couldn’t sign you in. Try the link again.' }
}

/** Monotonic milliseconds where available, so a wall-clock jump can't stretch or skip the cooldown. */
export function monotonicNow() {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  return typeof perf?.now === 'function' ? perf.now() : Date.now()
}

/**
 * Resend cooldowns keyed by normalized email, so going back with "Use a different email" and re-entering
 * the same address keeps the cooldown. Times come from monotonicNow().
 */
export function createCooldowns() {
  const sent = new Map<string, number>()
  return {
    mark(email: string, at: number) { sent.set(normalizeEmail(email), at) },
    last(email: string) { return sent.get(normalizeEmail(email)) ?? null },
  }
}

export function cooldownLeftMs(lastSentAt: number | null, now: number) {
  if (lastSentAt === null) return 0
  const elapsed = now - lastSentAt
  // A negative or absurd elapsed means the clock moved; clamp so we never show more than 30 s.
  return Math.min(RESEND_COOLDOWN_MS, Math.max(0, RESEND_COOLDOWN_MS - Math.max(0, elapsed)))
}

/** The Resend button on Check your email: "Sent again" briefly, then a 30 s cooldown. */
export function resendButton(state: { sentAt: number | null; resentAt: number | null; sending: boolean }, now: number) {
  if (state.sending) return { label: 'Sending…', disabled: true }
  if (state.resentAt !== null) {
    const since = now - state.resentAt
    if (since >= 0 && since < SENT_AGAIN_MS) return { label: 'Sent again', disabled: true }
  }
  const last = state.resentAt ?? state.sentAt
  const left = Math.ceil(cooldownLeftMs(last, now) / 1000)
  if (left > 0) return { label: `Resend in ${left} s`, disabled: true }
  return { label: 'Resend link', disabled: false }
}

/** Screen-reader announcements for the cooldown: only when it starts and when it ends, never per tick. */
export function cooldownAnnouncement(previousLeft: number, left: number) {
  if (previousLeft === 0 && left > 0) return `You can resend in ${left} seconds.`
  if (previousLeft > 0 && left === 0) return 'You can resend the link now.'
  return null
}
