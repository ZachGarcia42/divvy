import { codeOf, isTransient } from './errors'

export const CODE_LENGTH = 6

/** Digits only, at most 6. A pasted email line ("Your code is 123 456") yields its 6-digit run. */
export function sanitizeCode(input: string) {
  // No lookbehind: keep the regexes simple for every JS engine.
  const run = /(?:^|\D)(\d{6})(?!\d)/.exec(input)?.[1]
  if (run && input.replace(/\D/g, '').length > CODE_LENGTH) return run
  const spaced = /(?:^|\D)(\d{3}[\s-]\d{3})(?!\d)/.exec(input)?.[1]
  if (spaced) return spaced.replace(/\D/g, '')
  return input.replace(/\D/g, '').slice(0, CODE_LENGTH)
}

/** Auto-submit once there are 6 digits, but never twice for the same value. */
export function shouldSubmitCode(code: string, lastSubmitted: string | null, busy: boolean) {
  return !busy && code.length === CODE_LENGTH && code !== lastSubmitted
}

export type CodeFailure = { message: string; pointToResend: boolean; clearField: boolean }

export function codeFailure(reason: unknown): CodeFailure {
  const code = codeOf(reason)
  if (code === 'BAD_CODE') {
    const left = (reason as { attemptsLeft?: unknown }).attemptsLeft
    const message = typeof left === 'number'
      ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
      : 'That code isn’t right.'
    return { message, pointToResend: false, clearField: true }
  }
  if (code === 'CODE_EXPIRED') return { message: 'That code has expired. Tap Resend for a new code.', pointToResend: true, clearField: true }
  if (code === 'CODE_LOCKED') return { message: 'Too many tries. Tap Resend for a new code.', pointToResend: true, clearField: true }
  if (code === 'RATE_LIMITED') return { message: 'That’s a lot of tries. Wait a few minutes, then try again.', pointToResend: false, clearField: false }
  if (code === 'BAD_REQUEST') return { message: 'Enter the 6-digit code', pointToResend: false, clearField: false }
  if (isTransient(reason) || !code || code.startsWith('HTTP_')) {
    return { message: 'Couldn’t check the code. Check your signal and try again.', pointToResend: false, clearField: false }
  }
  return { message: reason instanceof Error ? reason.message : 'Couldn’t check the code.', pointToResend: false, clearField: false }
}
