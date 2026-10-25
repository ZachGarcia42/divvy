import { LedgerError } from '@divvy/domain'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { readFileSync } from 'node:fs'
import type { Sql } from './db.ts'
import { createVerifier, googleMayLink, hashNonce, isPrivateRelay, parseClientIds, type IdTokenVerifier } from './oauth.ts'
import { cleanNextPath, CodeError, normalizeEmail, Repo } from './repo.ts'

const COOKIE = 'divvy_session'

class RateLimitError extends LedgerError {
  constructor(readonly max: number, readonly retryAfter: number) {
    super('RATE_LIMITED', 'Too many sign-in links. Wait a few minutes and try again.')
  }
}

const LINK_TOKEN = /^[A-Za-z0-9_-]{16,128}$/
const isLinkToken = (value: unknown): value is string => typeof value === 'string' && LINK_TOKEN.test(value)
const safeNextPath = (next: string | undefined) => {
  if (!next) return null
  try {
    return cleanNextPath(next)
  } catch {
    return null
  }
}
/** Build id for /api/health: BUILD_SHA env, else a BUILD file written at deploy time, else "dev". */
export function resolveBuild(env: string | undefined = process.env.BUILD_SHA, file = 'BUILD') {
  const fromEnv = env?.trim()
  if (fromEnv) return fromEnv
  try {
    const fromFile = readFileSync(file, 'utf8').trim()
    if (fromFile) return fromFile
  } catch {}
  return 'dev'
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/** Removes bidi embedding/override/isolate controls so a name can't reorder surrounding text. */
export const stripBidi = (value: string) => value.replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
/** Escaped, bidi-stripped user text wrapped in <bdi> for the page heading. */
export const bdi = (value: string) => `<bdi>${escapeHtml(stripBidi(value))}</bdi>`

/** Minimal page that tries to open the app via a divvy:// deep link. headingHtml must already be escaped. */
export function linkPage(title: string, deepLink: string | null, headingHtml?: string) {
  const t = escapeHtml(title)
  const href = deepLink ? escapeHtml(deepLink) : null
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${t}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.5rem;text-align:center;color:#1a1a1a}a.button{display:inline-block;margin:1.5rem 0;padding:.9rem 1.6rem;border-radius:.75rem;background:#2f6f4f;color:#fff;text-decoration:none;font-weight:600}p{color:#555}</style>
${href ? `<meta http-equiv="refresh" content="0;url=${href}">` : ''}
</head><body>
<h1>${headingHtml ?? t}</h1>
${href ? `<a class="button" href="${href}">Open in Divvy</a>` : '<p>Ask for a new link.</p>'}
<p>Need the app? It’s in testing.</p>
</body></html>`
}

export const isLoopback = (ip: string | null) =>
  !!ip && (ip === '::1' || ip.startsWith('127.') || ip.startsWith('::ffff:127.'))

export function createApp(sql: Sql, options?: {
  now?: () => Date
  rateFor?: (from: string, to: string, date: string) => Promise<string>
  webOrigin?: string
  dev?: boolean
  devSigninEmails?: string[] | string | null
  adminToken?: string | null
  /** Per-email and per-IP limit on sign-in/email-change links. false disables (tests only). */
  rateLimit?: { max: number; windowMs: number } | false
  /** Trust the last X-Forwarded-For entry as the client IP (only behind a proxy you control). */
  trustProxy?: boolean
  /** Build id reported by /api/health (defaults to resolveBuild()). */
  build?: string
  /** Allowed Google OAuth client ids (aud). Defaults to GOOGLE_CLIENT_IDS; empty means /api/auth/google is 503. */
  googleClientIds?: string[] | string | null
  /** Allowed Apple client ids (aud). Defaults to APPLE_CLIENT_IDS; unset/empty means Apple is off (503). */
  appleClientIds?: string[] | string | null
  /** Test hook: replace JWKS-backed verification (e.g. a locally signed key). */
  verifiers?: { google?: IdTokenVerifier; apple?: IdTokenVerifier }
  /** Apple Service IDs (web flow aud). Defaults to APPLE_WEB_CLIENT_IDS. */
  appleWebClientIds?: string[] | string | null
  /** Per-provider nonce requirement. Defaults: apple true (APPLE_REQUIRE_NONCE), google false (GOOGLE_REQUIRE_NONCE). */
  requireNonce?: { google?: boolean; apple?: boolean }
}) {
  const build = options?.build ?? resolveBuild()
  const dev = options?.dev ?? process.env.NODE_ENV !== 'production'
  // Lockdown is on whenever an allowlist is supplied at all: the createApp option (even an empty
  // array or string) or the DEV_SIGNIN_EMAILS env var being present (even empty or whitespace).
  // Locked means only listed emails get a devToken (an empty list means no one does) and
  // /api/dev/* returns 404. Only an absent env var with no option keeps the old open dev behavior;
  // passing devSigninEmails: null explicitly opts out (tests only).
  const allowRaw = options?.devSigninEmails !== undefined ? options.devSigninEmails : process.env.DEV_SIGNIN_EMAILS
  const restricted = allowRaw != null
  const allowList = restricted
    ? (Array.isArray(allowRaw) ? allowRaw : allowRaw.split(',')).map((email) => String(email).trim().toLowerCase()).filter(Boolean)
    : []
  const devTokenFor = (email: unknown) => {
    if (!dev) return false
    if (!restricted) return true
    return typeof email === 'string' && allowList.includes(email.trim().toLowerCase())
  }
  const devRoutes = dev && !restricted
  const adminToken = (options?.adminToken !== undefined ? options.adminToken : process.env.ADMIN_TOKEN) || ''
  const limit = options?.rateLimit === undefined ? { max: 5, windowMs: 15 * 60 * 1000 } : options.rateLimit
  const trustProxy = options?.trustProxy ?? process.env.TRUST_PROXY === '1'
  const clock = () => (options?.now ?? (() => new Date()))().getTime()
  const hits = new Map<string, number[]>()
  const clientIp = (c: { req: { header: (name: string) => string | undefined }; env?: unknown }) => {
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
    const remote = env?.incoming?.socket?.remoteAddress ?? null
    // Trust X-Forwarded-For when TRUST_PROXY=1, or when the hop is loopback (Caddy on the same machine).
    if (trustProxy || isLoopback(remote)) {
      // The last entry is the one our own proxy appended; earlier entries are client-controlled.
      const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
      if (forwarded) return forwarded
    }
    return remote
  }
  /**
   * Throws RATE_LIMITED (429) if this email or IP already used its quota in the window; otherwise records the hit.
   * Code checks use their own buckets ('code') with twice the quota, so a few typos plus a Resend still fit.
   */
  const throttle = (c: { header: (name: string, value: string) => void }, email: string | null, ip: string | null, bucket: 'link' | 'code' | 'oauth' = 'link', request?: string | null) => {
    if (!limit) return
    const now = clock()
    const prefix = bucket === 'link' ? '' : `${bucket}-`
    // Provider sign-in is per IP only (there's no email before the token is verified), with 4x the quota.
    const max = bucket === 'code' ? limit.max * 2 : bucket === 'oauth' ? limit.max * 4 : limit.max
    // Code checks are limited per email *and current request*, so someone who only knows your email can't
    // burn your attempts for the whole window: a Resend starts a fresh bucket. The per-IP limit is unchanged.
    // Residual risk: they can still lock each new code (5 tries) and trigger Resends, but Resends are capped by
    // the link limit (5 per email per 15 min) and the magic link keeps working even when the code is locked.
    const emailKey = `${prefix}email:${(email ?? '').trim().toLowerCase()}${bucket === 'code' ? `:${request ?? 'none'}` : ''}`
    const keys = [...(email === null ? [] : [emailKey]), ...(ip ? [`${prefix}ip:${ip}`] : [])]
    if (!keys.length) return
    const recent = keys.map((key) => (hits.get(key) ?? []).filter((at) => now - at < limit.windowMs))
    keys.forEach((key, index) => hits.set(key, recent[index]!))
    // IETF RateLimit headers: the tightest of this request's buckets.
    const oldest = recent.map((list) => list[0]).filter((at): at is number => at !== undefined)
    const resetSeconds = (full: number[][]) => Math.max(1, Math.ceil(Math.max(0, ...full.map((list) => (list[0] ?? now) + limit.windowMs - now)) / 1000))
    if (recent.some((list) => list.length >= max)) {
      const reset = resetSeconds(recent.filter((list) => list.length >= max))
      throw new RateLimitError(max, reset)
    }
    keys.forEach((key, index) => recent[index]!.push(now))
    const remaining = Math.max(0, max - Math.max(...recent.map((list) => list.length)))
    c.header('RateLimit-Limit', String(max))
    c.header('RateLimit-Remaining', String(remaining))
    c.header('RateLimit-Reset', String(oldest.length ? resetSeconds(recent) : Math.ceil(limit.windowMs / 1000)))
    if (hits.size > 10_000) {
      for (const [key, list] of hits) if (!list.some((at) => now - at < limit.windowMs)) hits.delete(key)
    }
  }
  const repo = new Repo(sql, {
    now: options?.now ?? (() => new Date()),
    rateFor: options?.rateFor ?? ((from, to, date) => defaultRate(sql, from, to, date)),
    webOrigin: options?.webOrigin ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  })
  const app = new Hono()
  app.use('*', cors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:8081').split(','),
    credentials: true,
    allowHeaders: ['content-type', 'authorization', 'x-admin-token'],
  }))
  app.onError((error, c) => {
    if (error instanceof CodeError) {
      return c.json({ error: { code: error.code, message: error.message, ...(error.attemptsLeft !== undefined ? { attemptsLeft: error.attemptsLeft } : {}) } }, 401)
    }
    if (error instanceof RateLimitError) {
      c.header('Retry-After', String(error.retryAfter))
      c.header('RateLimit-Limit', String(error.max))
      c.header('RateLimit-Remaining', '0')
      c.header('RateLimit-Reset', String(error.retryAfter))
    }
    if (error instanceof LedgerError) {
      const status = error.code === 'UNAUTHENTICATED' || error.code === 'BAD_TOKEN' ? 401
        : error.code === 'NOT_CONFIGURED' ? 503
        : error.code === 'FORBIDDEN' || error.code === 'EMAIL_UNVERIFIED' || error.code === 'SUSPENDED' || error.code === 'BLOCKED' ? 403
        : error.code === 'NOT_FOUND' ? 404
        : error.code === 'STALE' || error.code === 'EMAIL_IN_USE' ? 409
        : error.code === 'RATE_LIMITED' ? 429
        : error.code === 'ARCHIVED' ? 410
        : 400
      return c.json({ error: { code: error.code, message: error.message } }, status)
    }
    console.error(error)
    return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong' } }, 500)
  })

  const tokenOf = (c: { req: { header: (name: string) => string | undefined } }) => {
    const header = c.req.header('authorization')
    if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7)
    return getCookie(c as never, COOKIE) ?? null
  }
  const actor = async (c: Parameters<typeof tokenOf>[0] & { json: Function }) => {
    try {
      const found = await repo.actorFromToken(tokenOf(c))
      if (!found) throw new LedgerError('UNAUTHENTICATED', 'Sign in')
      return found
    } catch (error) {
      if (error instanceof LedgerError) throw error
      throw error
    }
  }

  // Landing pages for links in emails and shares (WEB_ORIGIN may be this API). Each opens the app.
  app.get('/login', (c) => {
    const token = c.req.query('token')
    if (!isLinkToken(token)) return c.html(linkPage('That sign-in link isn’t valid', null), 400)
    const next = safeNextPath(c.req.query('next'))
    return c.html(linkPage('Sign in to Divvy', `divvy://login?token=${encodeURIComponent(token)}${next ? `&next=${encodeURIComponent(next)}` : ''}`))
  })
  app.get('/invite/:token', async (c) => {
    const token = c.req.param('token')
    if (!isLinkToken(token)) return c.html(linkPage('That invite link isn’t valid', null), 400)
    const deepLink = `divvy://invite/${encodeURIComponent(token)}`
    let title = 'You’re invited to a Divvy group'
    let heading: string | undefined
    try {
      const preview = await repo.publicInvitePreview(token)
      if (preview.status === 'valid' && preview.groupName) {
        const group = stripBidi(preview.groupName)
        const inviter = preview.inviterName ? stripBidi(preview.inviterName) : null
        title = inviter ? `${inviter} invited you to ${group}` : `You’re invited to ${group}`
        heading = inviter ? `${bdi(inviter)} invited you to ${bdi(group)}` : `You’re invited to ${bdi(group)}`
      }
    } catch {}
    return c.html(linkPage(title, deepLink, heading))
  })

  app.get('/api/health', (c) => c.json({ ok: true, build }))
  // Lets clients hide tester-only affordances (the sample apartment) without probing /api/dev/*.
  app.get('/api/config', (c) => c.json({ devSeed: devRoutes }))

  const readBody = async (c: { req: { json: () => Promise<unknown> } }) => {
    const body = await c.req.json().catch(() => null)
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  }
  const emailFromBody = (body: Record<string, unknown> | null) => {
    const email = body?.email
    if (typeof email !== 'string') throw new LedgerError('BAD_EMAIL', 'Enter a valid email')
    normalizeEmail(email) // validate before the request counts against the rate limit
    return email
  }
  const nextFromBody = (body: Record<string, unknown> | null) => {
    const next = body?.next
    if (next === undefined || next === null || next === '') return null
    return cleanNextPath(next)
  }

  app.post('/api/auth/magic-link', async (c) => {
    const raw = await readBody(c)
    const body = { email: emailFromBody(raw), next: nextFromBody(raw) }
    throttle(c, body.email, clientIp(c))
    const issued = await repo.requestMagicLink(body.email, 'login', undefined, body.next)
    const dev = devTokenFor(body.email)
    return c.json({ ok: true, devToken: dev ? issued.token : undefined, devCode: dev && issued.code ? issued.code : undefined })
  })

  app.post('/api/auth/verify', async (c) => {
    const body = await c.req.json().catch(() => null) as { token?: unknown } | null
    const token = body && typeof body === 'object' ? body.token : undefined
    if (typeof token !== 'string' || !token) throw new LedgerError('BAD_TOKEN', 'That sign-in link is no longer valid')
    const result = await repo.verifyMagicLink(token)
    setCookie(c, COOKIE, result.token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30 })
    return c.json(result)
  })

  app.post('/api/auth/verify-code', async (c) => {
    const body = await readBody(c)
    const email = emailFromBody(body)
    const code = body?.code
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new LedgerError('BAD_REQUEST', 'Enter the 6-digit code')
    throttle(c, email, clientIp(c), 'code', await repo.currentCodeRequest(email))
    const result = await repo.verifyCode(email, code)
    setCookie(c, COOKIE, result.token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30 })
    return c.json(result)
  })

  // Sign in with Google / Apple. Each provider is off (503) until its client ids are configured.
  const clientIdsFor = (option: string[] | string | null | undefined, env: string | undefined, fallback?: string) =>
    parseClientIds(option !== undefined ? option : env !== undefined ? env : fallback)
  const googleIds = clientIdsFor(options?.googleClientIds, process.env.GOOGLE_CLIENT_IDS)
  const appleIds = clientIdsFor(options?.appleClientIds, process.env.APPLE_CLIENT_IDS)
  // Apple Service IDs (web/Android flow). When set, an Apple token's aud must match the caller's platform.
  const appleWebIds = clientIdsFor(options?.appleWebClientIds, process.env.APPLE_WEB_CLIENT_IDS)
  // Nonce is required for Apple (expo-apple-authentication takes one). The free google-signin SDK can't take a
  // nonce, so Google requires it only when GOOGLE_REQUIRE_NONCE=true; a nonce that is sent is always checked.
  const flag = (option: boolean | undefined, env: string | undefined, fallback: boolean) =>
    option ?? (env === undefined || env === '' ? fallback : env === 'true')
  const requireNonce = {
    google: flag(options?.requireNonce?.google, process.env.GOOGLE_REQUIRE_NONCE, false),
    apple: flag(options?.requireNonce?.apple, process.env.APPLE_REQUIRE_NONCE, true),
  }
  const verifiers = {
    google: googleIds.length ? options?.verifiers?.google ?? createVerifier('google', googleIds, { now: options?.now }) : null,
    apple: appleIds.length ? options?.verifiers?.apple ?? createVerifier('apple', appleIds, { now: options?.now }) : null,
  }
  const providerSignIn = (provider: 'google' | 'apple', tokenField: 'idToken' | 'identityToken') => app.post(`/api/auth/${provider}`, async (c) => {
    const verify = verifiers[provider]
    if (!verify) throw new LedgerError('NOT_CONFIGURED', `Sign in with ${provider === 'google' ? 'Google' : 'Apple'} isn’t set up on this server`)
    const body = await readBody(c)
    const token = body?.[tokenField]
    if (typeof token !== 'string' || !token || token.length > 8192) throw new LedgerError('BAD_TOKEN', 'That sign-in didn’t work. Try again.')
    const next = nextFromBody(body)
    throttle(c, null, clientIp(c), 'oauth')
    const identity = await verify(token)
    const badToken = () => new LedgerError('BAD_TOKEN', 'That sign-in didn’t work. Try again.')
    const raw = typeof body?.nonce === 'string' && body.nonce.length >= 16 && body.nonce.length <= 256 ? body.nonce : null
    if (body?.nonce !== undefined && raw === null) throw badToken()
    if (raw !== null || identity.nonce || requireNonce[provider]) {
      if (raw === null || !identity.nonce || identity.nonce !== hashNonce(raw)) throw badToken()
    }
    const platform = body?.platform === 'web' || body?.platform === 'ios' || body?.platform === 'android' ? body.platform : null
    if (provider === 'apple' && appleWebIds.length && platform && identity.aud) {
      // Native iOS tokens carry the bundle id; the web/Android flow carries a Service ID.
      const isService = appleWebIds.includes(identity.aud)
      if ((platform === 'ios') === isService) throw badToken()
    }
    if (provider === 'google' && platform === 'web' && identity.azp && identity.azp !== identity.aud) throw badToken()
    if (provider === 'apple') {
      // Apple sends the name only on the very first authorization, from the device, not in the token.
      const cap = (part: unknown) => typeof part === 'string' ? part.slice(0, 100) : undefined
      const full = body?.fullName as { givenName?: unknown; familyName?: unknown } | string | null | undefined
      const name = typeof full === 'string' ? full.slice(0, 200)
        : full && typeof full === 'object' ? [cap(full.givenName), cap(full.familyName)].filter((part): part is string => !!part?.trim()).join(' ')
        : ''
      identity.name = name.trim() || null
    }
    const mayLink = provider === 'google' ? googleMayLink(identity) : !isPrivateRelay(identity.email)
    const result = await repo.signInWithIdentity({ ...identity, mayLink }, next)
    setCookie(c, COOKIE, result.token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30 })
    return c.json(result)
  })
  providerSignIn('google', 'idToken')
  providerSignIn('apple', 'identityToken')
  // What the login screen should offer. `email` is the tester email path (on when any devToken can be issued).
  app.get('/api/auth/providers', (c) => c.json({ google: !!verifiers.google, apple: !!verifiers.apple, email: dev && (!restricted || allowList.length > 0) }))

  app.post('/api/auth/logout', async (c) => {
    const token = tokenOf(c)
    if (token) await repo.logout(token)
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/api/me', async (c) => {
    const found = await repo.actorFromToken(tokenOf(c))
    return c.json(found)
  })
  app.patch('/api/me', async (c) => {
    const current = await actor(c)
    const body = await readBody(c)
    if (!body) throw new LedgerError('BAD_REQUEST', 'Send a JSON object')
    if (body.homeCurrency !== undefined && typeof body.homeCurrency !== 'string') throw new LedgerError('BAD_CURRENCY', 'Currency must be text')
    return c.json(await repo.updateMe(current, body as { displayName?: string; homeCurrency?: string }))
  })
  app.post('/api/me/email', async (c) => {
    const current = await actor(c)
    const body = { email: emailFromBody(await readBody(c)) }
    throttle(c, body.email, clientIp(c))
    const issued = await repo.requestMagicLink(body.email, 'email_change', current.userId)
    return c.json({ ok: true, devToken: devTokenFor(body.email) ? issued.token : undefined })
  })
  app.get('/api/claims', async (c) => c.json(await repo.claims(await actor(c))))
  app.post('/api/claims/:id', async (c) => {
    const body = await c.req.json<{ action: 'claim' | 'reject' }>()
    await repo.resolveClaim(await actor(c), c.req.param('id'), body.action)
    return c.json({ ok: true })
  })
  app.post('/api/participants/link', async (c) => {
    const body = await c.req.json<{ sourceId: string; targetId: string }>()
    await repo.linkParticipants(await actor(c), body.sourceId, body.targetId)
    return c.json({ ok: true })
  })

  app.get('/api/home', async (c) => c.json(await repo.home(await actor(c))))
  app.post('/api/groups', async (c) => c.json(await repo.createGroup(await actor(c), await c.req.json())))
  app.get('/api/groups/:id', async (c) => c.json(await repo.groupDetail(await actor(c), c.req.param('id'))))
  app.patch('/api/groups/:id', async (c) => c.json(await repo.updateGroup(await actor(c), c.req.param('id'), await c.req.json())))
  app.post('/api/groups/:id/archive', async (c) => c.json(await repo.archive(await actor(c), c.req.param('id'), true)))
  app.post('/api/groups/:id/unarchive', async (c) => c.json(await repo.archive(await actor(c), c.req.param('id'), false)))
  app.delete('/api/groups/:id', async (c) => {
    await repo.deleteGroup(await actor(c), c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/people', async (c) => c.json(await repo.addPerson(await actor(c), c.req.param('id'), await c.req.json())))
  app.post('/api/groups/:id/invite-link', async (c) => c.json(await repo.groupInviteLink(await actor(c), c.req.param('id'))))
  app.post('/api/groups/:id/defaults', async (c) => {
    const body = await c.req.json<{ weights: { participantId: string; weight: number | null }[] }>()
    await repo.setDefaults(await actor(c), c.req.param('id'), body.weights)
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/members/:participantId/remove', async (c) => {
    await repo.removeMember(await actor(c), c.req.param('id'), c.req.param('participantId'))
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/categories', async (c) => c.json(await repo.createCategory(await actor(c), c.req.param('id'), (await c.req.json<{ label: string }>()).label)))
  app.patch('/api/groups/:id/categories/:categoryId', async (c) => {
    await repo.renameCategory(await actor(c), c.req.param('id'), c.req.param('categoryId'), (await c.req.json<{ label: string }>()).label)
    return c.json({ ok: true })
  })
  app.delete('/api/groups/:id/categories/:categoryId', async (c) => {
    await repo.deleteCategory(await actor(c), c.req.param('id'), c.req.param('categoryId'))
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/expenses', async (c) => c.json(await repo.createExpense(await actor(c), c.req.param('id'), await c.req.json())))
  app.patch('/api/groups/:id/expenses/:expenseId', async (c) => {
    await repo.updateExpense(await actor(c), c.req.param('id'), c.req.param('expenseId'), await c.req.json())
    return c.json({ ok: true })
  })
  app.delete('/api/groups/:id/expenses/:expenseId', async (c) => {
    await repo.deleteExpense(await actor(c), c.req.param('id'), c.req.param('expenseId'))
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/expenses/:expenseId/restore', async (c) => {
    await repo.restoreExpense(await actor(c), c.req.param('id'), c.req.param('expenseId'))
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/expenses/:expenseId/move', async (c) => {
    const body = await c.req.json<{ destinationGroupId: string }>()
    await repo.moveExpense(await actor(c), c.req.param('id'), c.req.param('expenseId'), body.destinationGroupId)
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/expenses/:expenseId/images', async (c) => {
    const body = await c.req.json<{ contentType: string; dataBase64: string }>()
    return c.json(await repo.addImage(await actor(c), c.req.param('id'), c.req.param('expenseId'), body.contentType, body.dataBase64))
  })
  app.post('/api/groups/:id/settlements', async (c) => c.json(await repo.createSettlement(await actor(c), c.req.param('id'), await c.req.json())))
  app.delete('/api/groups/:id/settlements/:settlementId', async (c) => {
    await repo.deleteSettlement(await actor(c), c.req.param('id'), c.req.param('settlementId'))
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/settlements/:settlementId/restore', async (c) => {
    await repo.restoreSettlement(await actor(c), c.req.param('id'), c.req.param('settlementId'))
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/settlements/:settlementId/move', async (c) => {
    const body = await c.req.json<{ destinationGroupId: string }>()
    await repo.moveSettlement(await actor(c), c.req.param('id'), c.req.param('settlementId'), body.destinationGroupId)
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/nudges', async (c) => {
    await repo.nudge(await actor(c), c.req.param('id'), (await c.req.json<{ toParticipantId: string }>()).toParticipantId)
    return c.json({ ok: true })
  })
  app.post('/api/groups/:id/recurrences', async (c) => c.json(await repo.createRecurrence(await actor(c), c.req.param('id'), await c.req.json())))
  app.get('/api/groups/:id/activity', async (c) => c.json(await repo.listActivity(await actor(c), c.req.param('id'))))
  app.get('/api/groups/:id/charts', async (c) => c.json(await repo.charts(await actor(c), c.req.param('id'), c.req.query('from'), c.req.query('to'))))
  app.get('/api/groups/:id/comments', async (c) => c.json(await repo.comments(await actor(c), c.req.param('id'), c.req.query('targetId') ?? '')))
  app.post('/api/groups/:id/comments', async (c) => {
    const body = await readBody(c)
    if (!body) throw new LedgerError('BAD_COMMENT', 'Send a JSON object')
    return c.json(await repo.addComment(await actor(c), c.req.param('id'), body.targetType, body.targetId, body.body))
  })
  app.delete('/api/groups/:id/comments/:commentId', async (c) => {
    await repo.deleteComment(await actor(c), c.req.param('id'), c.req.param('commentId'))
    return c.json({ ok: true })
  })
  app.get('/api/groups/:id/export.csv', async (c) => {
    const csv = await repo.exportGroup(await actor(c), c.req.param('id'))
    return c.text(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="divvy.csv"' })
  })

  app.get('/api/invites/:token/preview', async (c) => c.json(await repo.publicInvitePreview(c.req.param('token'))))
  app.get('/api/invites/:token', async (c) => c.json(await repo.previewInvite(await actor(c), c.req.param('token'))))
  app.post('/api/invites/:token/accept', async (c) => c.json(await repo.acceptInvite(await actor(c), c.req.param('token'))))
  app.get('/api/people/:id', async (c) => c.json(await repo.person(await actor(c), c.req.param('id'))))
  app.post('/api/settle-all', async (c) => {
    const body = await c.req.json<{ otherParticipantId: string; lines: { groupId: string; fromId: string; toId: string; minor: number }[] }>()
    await repo.settleAll(await actor(c), body.otherParticipantId, body.lines)
    return c.json({ ok: true })
  })
  app.get('/api/search', async (c) => c.json(await repo.search(await actor(c), c.req.query('q') ?? '')))
  app.get('/api/me/charts', async (c) => c.json(await repo.personalCharts(await actor(c), c.req.query('from') ?? '0001-01-01', c.req.query('to') ?? '9999-12-31')))
  app.get('/api/notifications', async (c) => c.json(await repo.notifications(await actor(c))))
  app.post('/api/notifications/read', async (c) => {
    await repo.readNotifications(await actor(c))
    return c.json({ ok: true })
  })
  app.post('/api/blocks', async (c) => {
    await repo.block(await actor(c), (await c.req.json<{ userId: string }>()).userId)
    return c.json({ ok: true })
  })
  app.post('/api/reports', async (c) => {
    const body = await c.req.json<{ targetType: string; targetId: string; reason: string }>()
    await repo.report(await actor(c), body.targetType, body.targetId, body.reason)
    return c.json({ ok: true })
  })

  app.post('/api/dev/seed', async (c) => {
    if (!devRoutes) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
    const result = await repo.seed()
    setCookie(c, COOKIE, result.token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30 })
    return c.json(result)
  })
  app.get('/api/dev/outbox', async (c) => {
    if (!devRoutes) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
    return c.json(await repo.outbox())
  })
  app.post('/api/admin/users/:id/suspend', async (c) => {
    if (!adminToken || c.req.header('x-admin-token') !== adminToken) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Admin token required' } }, 403)
    }
    await repo.suspend(c.req.param('id'))
    return c.json({ ok: true })
  })

  return { app, repo }
}

async function defaultRate(sql: Sql, from: string, to: string, date: string) {
  const base = from.toUpperCase()
  const quote = to.toUpperCase()
  if (base === quote) return '1'
  const cached = await sql.query<{ rate: string }>(
    `select rate from fx_rates where base = $1 and quote = $2 and rate_date = $3`,
    [base, quote, date],
  )
  if (cached[0]) return String(cached[0].rate)
  let cursor = date
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(`https://api.frankfurter.app/${cursor}?from=${base}&to=${quote}`, { signal: AbortSignal.timeout(2500) })
      if (response.ok) {
        const body = await response.json() as { rates?: Record<string, number> }
        const rate = body.rates?.[quote]
        if (rate) {
          await sql.query(
            `insert into fx_rates (base, quote, rate_date, rate) values ($1,$2,$3,$4) on conflict do nothing`,
            [base, quote, date, String(rate)],
          )
          return String(rate)
        }
      }
    } catch {
      // Try the previous published day.
    }
    cursor = previousDate(cursor)
  }
  const fallback: Record<string, string> = {
    'EUR:USD': '1.08',
    'USD:EUR': '0.925926',
    'USD:GBP': '0.8',
    'GBP:USD': '1.25',
    'EUR:GBP': '0.86',
    'GBP:EUR': '1.162791',
  }
  const known = fallback[`${base}:${quote}`]
  if (known) return known
  throw new LedgerError('BAD_RATE', `No exchange rate for ${base} to ${quote}`)
}

function previousDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day! - 1))
  return date.toISOString().slice(0, 10)
}
