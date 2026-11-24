import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSubmitGuard, freshGoogleIdToken, type GoogleClient } from './providers'

/** A fake of Android's Google Sign-In: while an account stays signed in, signIn() returns the same cached ID token. */
function fakeGoogle(opts: { signOutFails?: boolean; cancel?: boolean; noToken?: boolean } = {}) {
  const calls: string[] = []
  let signedIn = false
  let cached: string | null = null
  let minted = 0
  const client: GoogleClient = {
    GoogleSignin: {
      hasPlayServices: async () => { calls.push('playServices'); return true },
      signOut: async () => { calls.push('signOut'); if (opts.signOutFails) throw new Error('no account'); signedIn = false; cached = null },
      signIn: async () => {
        calls.push('signIn')
        if (opts.cancel) return { type: 'cancelled', data: null }
        if (!signedIn) { signedIn = true; cached = `token-${++minted}` }
        return { type: 'success', data: { idToken: opts.noToken ? null : cached } }
      },
    },
    isSuccessResponse: (response: { type: string }) => response.type === 'success',
  }
  return { client, calls }
}

describe('a fresh Google ID token per sign-in attempt', () => {
  it('never hands the same token to two attempts (sign out of Divvy, then back in within the hour)', async () => {
    const { client, calls } = fakeGoogle()
    const first = await freshGoogleIdToken(client, 'android')
    const second = await freshGoogleIdToken(client, 'android')
    expect(first).toBe('token-1')
    expect(second).toBe('token-2')
    expect(calls).toEqual(['playServices', 'signOut', 'signIn', 'playServices', 'signOut', 'signIn'])
  })

  it('the old flow (signIn without signOut) would have re-sent the cached token: the bug this guards', async () => {
    const { client } = fakeGoogle()
    const a = await client.GoogleSignin.signIn() as { data: { idToken: string } }
    const b = await client.GoogleSignin.signIn() as { data: { idToken: string } }
    expect(b.data.idToken).toBe(a.data.idToken)
  })

  it('a failing SDK signOut (nobody signed in yet) doesn’t block sign-in; iOS skips the Play services check', async () => {
    const { client, calls } = fakeGoogle({ signOutFails: true })
    expect(await freshGoogleIdToken(client, 'ios')).toBe('token-1')
    expect(calls).toEqual(['signOut', 'signIn'])
  })

  it('cancel is null (no error); a success without a token is BAD_TOKEN', async () => {
    expect(await freshGoogleIdToken(fakeGoogle({ cancel: true }).client, 'android')).toBeNull()
    await expect(freshGoogleIdToken(fakeGoogle({ noToken: true }).client, 'android')).rejects.toMatchObject({ code: 'BAD_TOKEN' })
  })
})

describe('double submit', () => {
  it('drops a second tap while the first sign-in is still running, and allows the next one after', async () => {
    const guard = createSubmitGuard()
    let release!: () => void
    let runs = 0
    const slow = () => new Promise<void>((resolve) => { runs += 1; release = resolve })
    const first = guard(slow)
    expect(await guard(slow)).toBe(false)
    expect(runs).toBe(1)
    release()
    expect(await first).toBe(true)
    expect(await guard(async () => { runs += 1 })).toBe(true)
    expect(runs).toBe(2)
  })

  it('releases after a failure too', async () => {
    const guard = createSubmitGuard()
    await expect(guard(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await guard(async () => undefined)).toBe(true)
  })

  it('SocialSignIn routes Google through freshGoogleIdToken and every sign-in through the guard', () => {
    const src = readFileSync(join(__dirname, '..', 'SocialSignIn.tsx'), 'utf8')
    expect(src).toContain('const guard = useRef(createSubmitGuard()).current')
    expect(src).toMatch(/const run = \(provider: 'google' \| 'apple', getBody: .*\) => guard\(async \(\) => \{/)
    expect(src).toContain('await freshGoogleIdToken(google as unknown as GoogleClient, Platform.OS)')
    expect(src).not.toMatch(/GoogleSignin\.signIn\(\)/)
  })
})
