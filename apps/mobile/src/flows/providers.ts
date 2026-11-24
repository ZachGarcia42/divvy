import { codeOf, isTransient } from './errors'

export type Providers = { google: boolean; apple: boolean; email: boolean }

/**
 * Email sign-in is hidden for now (Zach, Nov 23): there is no mail provider, so only Google, and Apple on iOS, show,
 * whatever /api/auth/providers says. The server path (magic-link / verify-code, devToken testers) is untouched;
 * flip this to bring the email form back once mail delivery exists.
 */
export const EMAIL_SIGNIN_ENABLED = false

/**
 * If /api/auth/providers can't be read (older API, offline). With email on, keep the email path so testers aren't
 * stuck; with email hidden, offer the provider buttons (the server answers NOT_CONFIGURED if one is really off).
 */
export function fallbackProviders(emailEnabled = EMAIL_SIGNIN_ENABLED): Providers {
  return emailEnabled ? { google: false, apple: false, email: true } : { google: true, apple: true, email: false }
}
export const FALLBACK_PROVIDERS: Providers = fallbackProviders()

export function parseProviders(body: unknown, emailEnabled = EMAIL_SIGNIN_ENABLED): Providers {
  if (!body || typeof body !== 'object') return fallbackProviders(emailEnabled)
  const value = body as Record<string, unknown>
  return { google: value.google === true, apple: value.apple === true, email: emailEnabled && value.email !== false }
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

export type AppleWebConfig = { clientId: string; redirectURI: string }
/** Apple on web needs the Services ID (the token's aud) and its registered https return URL; both or nothing. */
export function appleWebConfig(env: Record<string, string | undefined>): AppleWebConfig | null {
  const clientId = env.EXPO_PUBLIC_APPLE_WEB_SERVICES_ID?.trim()
  const redirectURI = env.EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI?.trim()
  if (!clientId || !redirectURI || !/^https:\/\//.test(redirectURI)) return null
  return { clientId, redirectURI }
}

/**
 * Which buttons to draw: the server must accept the provider and this build must be able to run it. Apple runs on iOS
 * (native sheet, appleAvailable = isAvailableAsync) and on web (Apple JS, appleAvailable = Services ID configured);
 * Android has no Apple button.
 */
export function visibleButtons(server: Providers, device: { os: string; appleAvailable: boolean; googleConfigured: boolean }) {
  return {
    apple: server.apple && (device.os === 'ios' || device.os === 'web') && device.appleAvailable,
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

/** Apple JS gives `user.name` as { firstName, lastName }, only on the first authorization; map it to the native shape. */
export function appleWebName(user: { name?: { firstName?: string | null; lastName?: string | null } | null } | null | undefined) {
  return appleFullName(user?.name ? { givenName: user.name.firstName, familyName: user.name.lastName } : null)
}

/** Apple JS popup errors (`{ error }`) that mean the person closed it: map to a cancel code so no error shows. */
export function appleWebError(reason: unknown) {
  const error = (reason as { error?: unknown } | null)?.error
  if (error === 'popup_closed_by_user' || error === 'user_cancelled_authorize' || error === 'user_trigger_new_signin_flow') {
    return Object.assign(new Error('Cancelled'), { code: 'ERR_REQUEST_CANCELED' })
  }
  if (error === 'popup_blocked_by_browser') return Object.assign(new Error('Popup blocked'), { code: 'POPUP_BLOCKED' })
  return reason
}

/**
 * Nonce: the provider gets sha256(raw) as hex (Apple's convention) and the API gets raw, then checks the token's
 * nonce claim equals sha256(raw). Apple takes one; the free google-signin SDK (v16 signIn) has no nonce option,
 * so Google on mobile sends none (the server only requires it for Google when GOOGLE_REQUIRE_NONCE=true).
 */
export function nonceFromBytes(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function providerBody(provider: 'google' | 'apple', token: string, next: string | null, fullName?: { givenName?: string; familyName?: string }, extra?: { nonce?: string; platform?: string }) {
  return {
    ...(provider === 'google' ? { idToken: token } : { identityToken: token }),
    ...(extra?.nonce ? { nonce: extra.nonce } : {}),
    ...(extra?.platform ? { platform: extra.platform } : {}),
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
  if (code === 'POPUP_BLOCKED') return `Allow pop-ups for this site, then try Sign in with ${label} again.`
  if (code === 'PLAY_SERVICES_NOT_AVAILABLE') return 'Update Google Play services, then try again.'
  // Android DEVELOPER_ERROR (CommonStatusCodes 10): this install's signing certificate isn't registered with Google
  // (typically a Play-installed build whose Play app-signing SHA-1 has no Android OAuth client). Retrying won't help.
  if (provider === 'google' && (code === '10' || code === 'DEVELOPER_ERROR')) return 'Sign in with Google isn’t working in this version of Divvy yet. We’re fixing it; please try again after the next update.'
  if (isTransient(reason) || code?.startsWith('HTTP_')) return 'Couldn’t reach Divvy. Check your signal and try again.'
  return `Couldn’t sign in with ${label}. Try again.`
}
