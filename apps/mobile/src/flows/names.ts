import { codeOf, isNetwork } from './errors'

export const NAME_MAX = 80
export const COUNTER_FROM = 70
export const nameAskedKey = (userId: string) => `divvy.nameAsked.${userId}`

/** What the API's ensureUser names a new account: the email local part, first letter capitalized. */
export function derivedName(email: string) {
  const local = email.split('@')[0] ?? 'friend'
  // Same as the server: capitalize, cut to 80 (never mid-surrogate), trim.
  let name = (local.charAt(0).toUpperCase() + local.slice(1)).slice(0, NAME_MAX)
  if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1)
  return name.trim() || 'Friend'
}

export function looksDerived(displayName: string, email: string) {
  return displayName.trim() === derivedName(email)
}

export function shouldAskName(me: { displayName: string; email: string } | null, alreadyAsked: boolean) {
  return !!me && !alreadyAsked && looksDerived(me.displayName, me.email)
}

/** Live validation on the trimmed name (2c). */
export function checkName(text: string) {
  const length = text.trim().length
  const counter = length >= COUNTER_FROM ? `${length}/${NAME_MAX}` : null
  if (length === 0) return { error: 'Enter a name', canSave: false, counter }
  if (length > NAME_MAX) return { error: 'Use a name of 80 characters or fewer', canSave: false, counter }
  return { error: null, canSave: true, counter }
}

export function saveNameError(reason: unknown) {
  if (codeOf(reason) === 'BAD_NAME' && reason instanceof Error) return reason.message
  if (isNetwork(reason) || !codeOf(reason)) return 'Couldn’t save. Check your signal and try again.'
  return reason instanceof Error ? reason.message : 'Couldn’t save.'
}
