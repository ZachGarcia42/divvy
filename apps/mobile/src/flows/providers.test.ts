import { describe, expect, it } from 'vitest'
import { appleFullName, FALLBACK_PROVIDERS, googleIds, isCancel, parseProviders, providerBody, providerErrorMessage, visibleButtons } from './providers'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { googleIosUrlScheme } = require('../../app.config.js') as { googleIosUrlScheme: (env: Record<string, string | undefined>) => string | null }

const err = (code: string, status?: number) => Object.assign(new Error('x'), { code, status })

describe('provider sign-in', () => {
  it('parses /api/auth/providers and falls back to the email path', () => {
    expect(parseProviders({ google: true, apple: false, email: false })).toEqual({ google: true, apple: false, email: false })
    expect(parseProviders({ devSeed: true })).toEqual({ google: false, apple: false, email: true })
    expect(parseProviders(null)).toEqual(FALLBACK_PROVIDERS)
  })

  it('needs the web client id, plus the iOS id on iOS', () => {
    expect(googleIds({}, 'android')).toBeNull()
    expect(googleIds({ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'w' }, 'android')).toEqual({ webClientId: 'w' })
    expect(googleIds({ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'w' }, 'ios')).toBeNull()
    expect(googleIds({ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'w', EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'i' }, 'ios')).toEqual({ webClientId: 'w', iosClientId: 'i' })
  })

  it('shows Apple only on iOS when available, and each button only when the server accepts it', () => {
    const all = { google: true, apple: true, email: true }
    expect(visibleButtons(all, { os: 'ios', appleAvailable: true, googleConfigured: true })).toEqual({ apple: true, google: true, email: true })
    expect(visibleButtons(all, { os: 'android', appleAvailable: true, googleConfigured: true }).apple).toBe(false)
    expect(visibleButtons(all, { os: 'ios', appleAvailable: false, googleConfigured: false })).toEqual({ apple: false, google: false, email: true })
    expect(visibleButtons({ google: false, apple: false, email: false }, { os: 'ios', appleAvailable: true, googleConfigured: true })).toEqual({ apple: false, google: false, email: false })
  })

  it('builds request bodies with the invite next and Apple first-time name', () => {
    expect(providerBody('google', 't', null)).toEqual({ idToken: 't' })
    expect(providerBody('google', 't', '/invite/abc', { givenName: 'X' })).toEqual({ idToken: 't', next: '/invite/abc' })
    expect(providerBody('apple', 't', '/invite/abc', { givenName: 'Jo' })).toEqual({ identityToken: 't', next: '/invite/abc', fullName: { givenName: 'Jo' } })
    expect(appleFullName({ givenName: ' Jo ', familyName: null })).toEqual({ givenName: 'Jo', familyName: undefined })
    expect(appleFullName({ givenName: '', familyName: '' })).toBeUndefined()
    expect(appleFullName(null)).toBeUndefined()
  })

  it('stays quiet on cancel and maps server errors to copy', () => {
    expect(isCancel(err('ERR_REQUEST_CANCELED'))).toBe(true)
    expect(providerErrorMessage('apple', err('ERR_REQUEST_CANCELED'))).toBeNull()
    expect(providerErrorMessage('google', err('SIGN_IN_CANCELLED'))).toBeNull()
    expect(providerErrorMessage('google', err('EMAIL_UNVERIFIED', 403))).toMatch(/Google email isn’t verified/)
    expect(providerErrorMessage('google', err('NOT_CONFIGURED', 503))).toMatch(/isn’t available yet/)
    expect(providerErrorMessage('apple', err('RATE_LIMITED', 429))).toMatch(/Wait a few minutes/)
    expect(providerErrorMessage('apple', err('BAD_TOKEN', 401))).toBe('Apple sign-in didn’t work. Try again.')
    expect(providerErrorMessage('google', err('NETWORK'))).toMatch(/Couldn’t reach Divvy/)
  })

  it('derives the Google iOS URL scheme for the config plugin', () => {
    expect(googleIosUrlScheme({})).toBeNull()
    expect(googleIosUrlScheme({ EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: '123-abc.apps.googleusercontent.com' })).toBe('com.googleusercontent.apps.123-abc')
    expect(googleIosUrlScheme({ EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME: 'com.googleusercontent.apps.x', EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'y' })).toBe('com.googleusercontent.apps.x')
  })
})
