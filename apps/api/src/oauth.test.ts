import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createMemorySql } from './db.ts'
import { createVerifier, hashNonce } from './oauth.ts'

const NOW = new Date('2026-10-25T15:00:00Z')
let keys: ReturnType<typeof createLocalJWKSet>
let sign: (claims: Record<string, unknown>, opts?: { iss?: string; aud?: string; exp?: number }) => Promise<string>
let otherKey: CryptoKey

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }
  keys = createLocalJWKSet({ keys: [jwk] })
  sign = (claims, opts = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? 'web.apps.googleusercontent.com')
    .setIssuedAt(Math.floor(NOW.getTime() / 1000) - 10)
    .setExpirationTime(opts.exp ?? Math.floor(NOW.getTime() / 1000) + 3600)
    .sign(privateKey)
})

async function setup(extra: Parameters<typeof createApp>[1] = {}) {
  const sql = await createMemorySql()
  const now = () => NOW
  const created = createApp(sql, {
    now, dev: true, rateFor: async () => '1', devSigninEmails: null,
    googleClientIds: 'web.apps.googleusercontent.com, ios.apps.googleusercontent.com',
    appleClientIds: 'app.divvy.ledger',
    verifiers: {
      google: createVerifier('google', ['web.apps.googleusercontent.com', 'ios.apps.googleusercontent.com'], { keys, now }),
      apple: createVerifier('apple', ['app.divvy.ledger'], { keys, now }),
    },
    ...extra,
  })
  const post = (path: string, body: unknown) => created.app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { ...created, post, sql }
}

const RAW = 'raw-nonce-0123456789abcdef'
const apple = (claims: Record<string, unknown>, aud = 'app.divvy.ledger') => sign({ nonce: hashNonce(RAW), ...claims }, { iss: 'https://appleid.apple.com', aud })
const google = (sub: string, email: string, extra: Record<string, unknown> = {}) => sign({ sub, email, email_verified: true, name: 'Alex Rivera', ...extra })

describe('Sign in with Google / Apple', () => {
  it('signs in with a valid Google token and issues a working session', async () => {
    const { post, app } = await setup()
    const res = await post('/api/auth/google', { idToken: await google('g-1', 'Alex@Example.com') })
    expect(res.status).toBe(200)
    const body = await res.json() as { token: string; user: { email: string; displayName: string }; next: null }
    expect(body.user.email).toBe('alex@example.com')
    expect(body.user.displayName).toBe('Alex Rivera')
    expect(body.next).toBeNull()
    const me = await (await app.request('/api/me', { headers: { authorization: `Bearer ${body.token}` } })).json() as { email: string }
    expect(me.email).toBe('alex@example.com')
  })

  it('accepts both Google issuer spellings and any configured aud', async () => {
    const { post } = await setup()
    expect((await post('/api/auth/google', { idToken: await sign({ sub: 'g-2', email: 'a@example.com', email_verified: true }, { iss: 'accounts.google.com', aud: 'ios.apps.googleusercontent.com' }) })).status).toBe(200)
  })

  it('rejects a bad aud, wrong issuer, expired token, bad signature and garbage', async () => {
    const { post } = await setup()
    const claims = { sub: 'g-3', email: 'a@example.com', email_verified: true }
    const bad = [
      await sign(claims, { aud: 'someone-else.apps.googleusercontent.com' }),
      await sign(claims, { iss: 'https://evil.example.com' }),
      await sign(claims, { exp: Math.floor(NOW.getTime() / 1000) - 60 }),
      await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://accounts.google.com').setAudience('web.apps.googleusercontent.com').setExpirationTime('1h').sign(otherKey),
      'not-a-jwt',
    ]
    for (const idToken of bad) {
      const res = await post('/api/auth/google', { idToken })
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_TOKEN')
    }
    expect((await post('/api/auth/google', {})).status).toBe(401)
  })

  it('refuses an unverified Google email', async () => {
    const { post } = await setup()
    const res = await post('/api/auth/google', { idToken: await google('g-4', 'a@example.com', { email_verified: false }) })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('EMAIL_UNVERIFIED')
  })

  it('links to an existing email user, then by sub even after the email changes', async () => {
    const { post } = await setup()
    const issued = await (await post('/api/auth/magic-link', { email: 'sam@gmail.com' })).json() as { devToken: string }
    const first = await (await post('/api/auth/verify', { token: issued.devToken })).json() as { user: { id: string } }
    const viaGoogle = await (await post('/api/auth/google', { idToken: await google('g-5', 'sam@gmail.com') })).json() as { user: { id: string } }
    expect(viaGoogle.user.id).toBe(first.user.id)
    const renamed = await (await post('/api/auth/google', { idToken: await google('g-5', 'sam.new@example.com') })).json() as { user: { id: string } }
    expect(renamed.user.id).toBe(first.user.id)
    // Apple with the same verified email links to the same person too.
    const appleToken = await apple({ sub: 'a-5', email: 'sam@gmail.com', email_verified: 'true' })
    const viaApple = await (await post('/api/auth/apple', { identityToken: appleToken, nonce: RAW })).json() as { user: { id: string } }
    expect(viaApple.user.id).toBe(first.user.id)
  })

  it('saves the Apple name from the first sign-in and signs in later without an email', async () => {
    const { post } = await setup()
    const firstToken = await apple({ sub: 'a-6', email: 'relay123@privaterelay.appleid.com', email_verified: 'true' })
    const first = await (await post('/api/auth/apple', { identityToken: firstToken, nonce: RAW, fullName: { givenName: 'Jo', familyName: 'Park' } })).json() as { user: { id: string; displayName: string } }
    expect(first.user.displayName).toBe('Jo Park')
    const laterToken = await apple({ sub: 'a-6' })
    const later = await (await post('/api/auth/apple', { identityToken: laterToken, nonce: RAW })).json() as { user: { id: string; displayName: string } }
    expect(later.user).toEqual(first.user)
    // An Apple token with a Google aud/issuer is refused.
    expect((await post('/api/auth/apple', { identityToken: await google('g-7', 'x@example.com') })).status).toBe(401)
  })

  it('returns 503 for a provider without client ids', async () => {
    const { post, app } = await setup({ googleClientIds: '', appleClientIds: [] })
    const res = await post('/api/auth/google', { idToken: 'x' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_CONFIGURED')
    expect((await post('/api/auth/apple', { identityToken: 'x' })).status).toBe(503)
    expect(await (await app.request('/api/auth/providers')).json()).toEqual({ google: false, apple: false, email: true })
    const locked = (await setup({ devSigninEmails: [] })).app
    expect(await (await locked.request('/api/auth/providers')).json()).toEqual({ google: true, apple: true, email: false })
  })

  it('carries the invite next path through and refuses an off-site next', async () => {
    const { post } = await setup()
    const ok = await (await post('/api/auth/google', { idToken: await google('g-8', 'n@example.com'), next: '/invite/abcdefghijklmnop' })).json() as { next: string }
    expect(ok.next).toBe('/invite/abcdefghijklmnop')
    expect((await post('/api/auth/google', { idToken: await google('g-8', 'n@example.com'), next: 'https://evil.example.com' })).status).toBe(400)
  })

  it('rate-limits provider sign-in per IP (4x the link quota)', async () => {
    const { app } = await setup({ rateLimit: { max: 1, windowMs: 60_000 }, trustProxy: true })
    const idToken = await google('g-9', 'r@example.com')
    const from = (ip: string) => app.request('/api/auth/google', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ idToken }),
    })
    for (let i = 0; i < 4; i++) expect((await from('203.0.113.1')).status).toBe(200)
    const limited = await from('203.0.113.1')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    expect((await from('203.0.113.2')).status).toBe(200)
  })

  it('requires a matching Apple nonce (claim = sha256(raw))', async () => {
    const { post } = await setup()
    const token = await apple({ sub: 'a-n', email: 'n1@icloud.com', email_verified: 'true' })
    for (const body of [{ identityToken: token }, { identityToken: token, nonce: 'wrong-nonce-0123456789' }, { identityToken: token, nonce: hashNonce(RAW) }, { identityToken: token, nonce: 5 }]) {
      expect((await post('/api/auth/apple', body)).status, JSON.stringify(body)).toBe(401)
    }
    const noClaim = await sign({ sub: 'a-n', email: 'n1@icloud.com', email_verified: 'true' }, { iss: 'https://appleid.apple.com', aud: 'app.divvy.ledger' })
    expect((await post('/api/auth/apple', { identityToken: noClaim, nonce: RAW })).status).toBe(401)
    expect((await post('/api/auth/apple', { identityToken: token, nonce: RAW })).status).toBe(200)
  })

  it('checks a Google nonce when sent and requires it only behind the flag', async () => {
    const { post } = await setup()
    const withNonce = await google('g-n', 'gn@gmail.com', { nonce: hashNonce(RAW) })
    expect((await post('/api/auth/google', { idToken: withNonce })).status).toBe(401) // claim present, raw missing
    expect((await post('/api/auth/google', { idToken: withNonce, nonce: 'other-nonce-0123456789' })).status).toBe(401)
    expect((await post('/api/auth/google', { idToken: await google('g-n', 'gn@gmail.com'), nonce: RAW })).status).toBe(401) // raw sent, no claim
    expect((await post('/api/auth/google', { idToken: withNonce, nonce: RAW })).status).toBe(200)
    expect((await post('/api/auth/google', { idToken: await google('g-n', 'gn@gmail.com') })).status).toBe(200)
    const strict = await setup({ requireNonce: { google: true } })
    expect((await strict.post('/api/auth/google', { idToken: await google('g-n', 'gn@gmail.com') })).status).toBe(401)
  })

  it('checks Apple aud per platform when Service IDs are configured', async () => {
    const now = () => NOW
    const { post } = await setup({
      appleClientIds: 'app.divvy.ledger,app.divvy.web', appleWebClientIds: 'app.divvy.web',
      verifiers: {
        google: createVerifier('google', ['web.apps.googleusercontent.com'], { keys, now }),
        apple: createVerifier('apple', ['app.divvy.ledger', 'app.divvy.web'], { keys, now }),
      },
    })
    const native = await apple({ sub: 'a-p', email: 'p@icloud.com', email_verified: 'true' })
    const web = await apple({ sub: 'a-p', email: 'p@icloud.com', email_verified: 'true' }, 'app.divvy.web')
    expect((await post('/api/auth/apple', { identityToken: web, nonce: RAW, platform: 'ios' })).status).toBe(401)
    expect((await post('/api/auth/apple', { identityToken: native, nonce: RAW, platform: 'web' })).status).toBe(401)
    expect((await post('/api/auth/apple', { identityToken: native, nonce: RAW, platform: 'ios' })).status).toBe(200)
    expect((await post('/api/auth/apple', { identityToken: web, nonce: RAW, platform: 'android' })).status).toBe(200)
  })

  it('rejects a Google web token whose azp is another client', async () => {
    const { post } = await setup()
    const token = await google('g-z', 'z@gmail.com', { azp: 'ios.apps.googleusercontent.com' })
    expect((await post('/api/auth/google', { idToken: token, platform: 'web' })).status).toBe(401)
    expect((await post('/api/auth/google', { idToken: token, platform: 'ios' })).status).toBe(200)
  })

  it('Google links by email only for @gmail.com or hd accounts', async () => {
    const { post } = await setup()
    const issued = await (await post('/api/auth/magic-link', { email: 'kim@corp.example' })).json() as { devToken: string }
    const first = await (await post('/api/auth/verify', { token: issued.devToken })).json() as { user: { id: string } }
    const takeover = await post('/api/auth/google', { idToken: await google('g-k', 'kim@corp.example') })
    expect(takeover.status).toBe(409)
    expect(((await takeover.json()) as { error: { code: string } }).error.code).toBe('EMAIL_IN_USE')
    const workspace = await (await post('/api/auth/google', { idToken: await google('g-k2', 'kim@corp.example', { hd: 'corp.example' }) })).json() as { user: { id: string } }
    expect(workspace.user.id).toBe(first.user.id)
    const fresh = await post('/api/auth/google', { idToken: await google('g-k3', 'new@other.example') })
    expect(fresh.status).toBe(200)
  })

  it('never auto-links an Apple private-relay address', async () => {
    const { post } = await setup()
    const issued = await (await post('/api/auth/magic-link', { email: 'abc@privaterelay.appleid.com' })).json() as { devToken: string }
    await post('/api/auth/verify', { token: issued.devToken })
    const res = await post('/api/auth/apple', { identityToken: await apple({ sub: 'a-r', email: 'abc@privaterelay.appleid.com', email_verified: 'true' }), nonce: RAW })
    expect(res.status).toBe(409)
  })

  it('caps the Apple fullName parts and refuses a suspended user a session', async () => {
    const { post, sql } = await setup()
    const long = 'x'.repeat(5000)
    const res = await (await post('/api/auth/apple', { identityToken: await apple({ sub: 'a-l', email: 'l@icloud.com', email_verified: 'true' }), nonce: RAW, fullName: { givenName: long, familyName: long } })).json() as { user: { id: string; displayName: string } }
    expect(res.user.displayName.length).toBeLessThanOrEqual(60)
    await sql.query(`update users set suspended_at = now() where id = $1`, [res.user.id])
    const again = await post('/api/auth/apple', { identityToken: await apple({ sub: 'a-l' }), nonce: RAW })
    expect(again.status).toBe(403)
    expect(again.headers.get('set-cookie')).toBeNull()
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('SUSPENDED')
  })

  it('leaves Apple off when APPLE_CLIENT_IDS is unset (no default)', async () => {
    const saved = process.env.APPLE_CLIENT_IDS
    delete process.env.APPLE_CLIENT_IDS
    try {
      const { app } = createApp(await createMemorySql(), { dev: true, rateFor: async () => '1', googleClientIds: 'web.apps.googleusercontent.com' })
      expect(await (await app.request('/api/auth/providers')).json()).toMatchObject({ google: true, apple: false })
    } finally {
      if (saved !== undefined) process.env.APPLE_CLIENT_IDS = saved
    }
  })
})
