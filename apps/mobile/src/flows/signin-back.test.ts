import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emailUnavailable, sendErrorMessage, signInBack, signInStage } from './signin'
import { providerErrorMessage } from './providers'

const err = (code: string, status?: number, message = 'x') => Object.assign(new Error(message), { code, status })
const source = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8')
/** The body of one exported component, up to the next top-level export or function. */
const component = (text: string, name: string) => {
  const start = text.indexOf(`export function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  const rest = text.slice(start + 1)
  const end = rest.search(/\n(export )?function /)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('going back from the code entry screen', () => {
  it('knows which sign-in screen is showing, in SignIn’s order', () => {
    expect(signInStage({ verifying: true, sentTo: 'a@b.co', linkExpired: true })).toBe('signing-in')
    expect(signInStage({ verifying: false, sentTo: 'a@b.co', linkExpired: true })).toBe('check-email')
    expect(signInStage({ verifying: false, sentTo: null, linkExpired: true })).toBe('expired')
    expect(signInStage({ verifying: false, sentTo: null, linkExpired: false })).toBe('entry')
  })

  it('Android Back returns to email entry from Check your email and the expired link, never closes the app there', () => {
    expect(signInBack('check-email')).toBe('to-entry')
    expect(signInBack('expired')).toBe('to-entry')
    expect(signInBack('signing-in')).toBe('ignore')
    expect(signInBack('entry')).toBe('os')
  })

  it('Check your email has a Back at the top, above the code field, and scrolls so the keyboard can’t trap it', () => {
    const check = component(source('November.tsx'), 'CheckEmail')
    const back = check.indexOf('<BackBar onBack={onBack} testID="check-email-back"')
    expect(back).toBeGreaterThan(-1)
    expect(back).toBeLessThan(check.indexOf('<CodeField'))
    expect(check).toMatch(/<ScrollView[^>]*keyboardShouldPersistTaps="handled"/)
    expect(check).toContain('testID="different-email" label="Use a different email" onPress={onBack}')
    expect(component(source('November.tsx'), 'ExpiredLink')).toContain('testID="expired-link-back"')
  })

  it('SignIn wires Android hardware Back through signInBack and the same backToEntry', () => {
    const signIn = source('App.tsx').split('function SignIn(')[1]!.split('\nfunction ')[0]!
    expect(signIn).toContain("BackHandler.addEventListener('hardwareBackPress'")
    expect(signIn).toMatch(/signInBack\(stage\)[\s\S]*if \(action === 'to-entry'\) backToEntry\(\)/)
    expect(signIn).toMatch(/onBack=\{backToEntry\}/)
  })
})

describe('email that can’t be delivered and misconfigured Google', () => {
  it('shows the server’s EMAIL_UNAVAILABLE as a pointer to the buttons this platform has, not as a signal problem', () => {
    const google = 'Email sign-in isn’t available yet. Use Sign in with Google above.'
    const both = 'Email sign-in isn’t available yet. Use Sign in with Google or Apple above.'
    expect(emailUnavailable('ios')).toBe(both)
    expect(emailUnavailable('android')).toBe(google)
    expect(emailUnavailable('web')).toBe(google)
    expect(emailUnavailable(undefined)).toBe(google)
    expect(sendErrorMessage(err('EMAIL_UNAVAILABLE', 403, 'Email sign-in isn’t available yet. Use Sign in with Google or Apple.'), 'android')).toBe(google)
    expect(sendErrorMessage(err('EMAIL_UNAVAILABLE', 403), 'ios')).toBe(both)
    expect(sendErrorMessage(err('EMAIL_UNAVAILABLE', 403))).toBe(google)
  })

  it('every sign-in caller passes Platform.OS so the copy matches the buttons', () => {
    for (const file of ['App.tsx', 'November.tsx']) {
      const calls = source(file).match(/sendErrorMessage\([^)]*\)/g) ?? []
      expect(calls.length, file).toBeGreaterThan(0)
      for (const call of calls) expect(call, file).toBe('sendErrorMessage(reason, Platform.OS)')
    }
  })

  it('names an Android DEVELOPER_ERROR (code 10) instead of a generic Try again', () => {
    expect(providerErrorMessage('google', err('10'))).toMatch(/isn’t working in this version of Divvy yet/)
    expect(providerErrorMessage('google', err('DEVELOPER_ERROR'))).toMatch(/isn’t working in this version/)
    expect(providerErrorMessage('apple', err('10'))).toBe('Couldn’t sign in with Apple. Try again.')
    expect(providerErrorMessage('google', err('SIGN_IN_CANCELLED'))).toBeNull()
  })
})
