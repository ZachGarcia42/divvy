import { codeOf, isTransient } from './errors'

export type Providers = { google: boolean; apple: boolean; email: boolean }
/** If /api/auth/providers can't be read (older API, offline), keep the email path so testers aren't stuck. */
export const FALLBACK_PROVIDERS: Providers = { google: false, apple: false, email: true }

export function parseProviders(body: unknown): Providers {
  if (!body || typeof body !== 'object') return FALLBACK_PROVIDERS
  const value = body as Record<string, unknown>
  return { google: value.google === true, apple: value.apple === true, email: value.email !== false }
}

export type GoogleIds = { webClientId: string; iosClientId?: string }
/** Google needs the web client id (it becomes the token's aud) on both platforms; iOS also needs its own. */
export function googleIds(env: Record<string, string | undefined>, os: string): GoogleIds | null {
  const webClientId = env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim()
  const iosClientId = env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim()
  if (!webClientId) return null
  if (os === 'ios' && !iosClientId) return null
  return iosClientId ? { webClientId, iosClientId } : { webClientId }
}

/** Which buttons to draw: the server must accept the provider and this build must be able to run it. */
export function visibleButtons(server: Providers, device: { os: string; appleAvailable: boolean; googleConfigured: boolean }) {
  return {
    apple: server.apple && device.os === 'ios' && device.appleAvailable,
    google: server.google && device.googleConfigured,
    email: server.email,
  }
}

/** Apple gives the name only on the first authorization; send it so the server can save it. */
export function appleFullName(name: { givenName?: string | null; familyName?: string | null } | null | undefined) {
  const givenName = name?.givenName?.trim() || undefined
  const familyName = name?.familyName?.trim() || undefined
  return givenName || familyName ? { givenName, familyName } : undefined
}

export function providerBody(provider: 'google' | 'apple', token: string, next: string | null, fullName?: { givenName?: string; familyName?: string }) {
  return {
    ...(provider === 'google' ? { idToken: token } : { identityToken: token }),
    ...(next ? { next } : {}),
    ...(provider === 'apple' && fullName ? { fullName } : {}),
  }
}

/** The user backed out of the Google/Apple sheet: no error. */
export function isCancel(reason: unknown) {
  const code = codeOf(reason) as string | undefined
  return code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED' || code === 'SIGN_IN_CANCELLED' || code === '-5' || code === '12501'
}

export function providerErrorMessage(provider: 'google' | 'apple', reason: unknown): string | null {
  if (isCancel(reason)) return null
  const label = provider === 'google' ? 'Google' : 'Apple'
  const code = codeOf(reason)
  if (code === 'RATE_LIMITED') return 'Too many tries. Wait a few minutes, then try again.'
  if (code === 'EMAIL_UNVERIFIED') return `Your ${label} email isn’t verified yet. Verify it with ${label}, then try again.`
  if (code === 'NOT_CONFIGURED') return `Sign in with ${label} isn’t available yet.`
  if (code === 'BAD_TOKEN') return `${label} sign-in didn’t work. Try again.`
  if (code === 'PLAY_SERVICES_NOT_AVAILABLE') return 'Update Google Play services, then try again.'
  if (isTransient(reason) || code?.startsWith('HTTP_')) return 'Couldn’t reach Divvy. Check your signal and try again.'
  return `Couldn’t sign in with ${label}. Try again.`
}
