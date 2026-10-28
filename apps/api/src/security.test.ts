import { describe, expect, it } from 'vitest'
import { createApp, HTML_CSP } from './app.ts'
import { listenOptions } from './config.ts'
import { createMemorySql } from './db.ts'

const ORIGIN = 'https://divvy.mooo.com'
const json = { 'content-type': 'application/json', 'x-divvy-platform': 'ios' }

async function setup(webOrigin = ORIGIN) {
  const { app } = createApp(await createMemorySql(), { dev: true, rateFor: async () => '1', devSigninEmails: null, rateLimit: false, webOrigin })
  const signIn = async (email: string) => {
    const issued = await (await app.request('/api/auth/magic-link', { method: 'POST', headers: json, body: JSON.stringify({ email }) })).json() as { devToken: string }
    return (await (await app.request('/api/auth/verify', { method: 'POST', headers: json, body: JSON.stringify({ token: issued.devToken }) })).json()) as { token: string }
  }
  return { app, signIn }
}

describe('security headers', () => {
  it('sends HSTS, nosniff and no-referrer on JSON, errors and HTML', async () => {
    const { app } = await setup()
    for (const res of [await app.request('/api/health'), await app.request('/api/me/charts'), await app.request('/nope'), await app.request('/login?token=abcdefghijklmnopqrst'), await app.request('/invite/bad')]) {
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    }
  })

  it('puts the CSP on HTML pages only, and it allows what the landing pages use', async () => {
    const { app } = await setup()
    expect((await app.request('/api/health')).headers.get('content-security-policy')).toBeNull()
    const page = await app.request('/invite/abcdefghijklmnopqrst')
    const csp = page.headers.get('content-security-policy')!
    expect(csp).toBe(HTML_CSP)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("style-src 'unsafe-inline'")
    expect(csp).toContain("img-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    const html = await page.text()
    // Nothing on the page needs more than the CSP allows: no scripts, external styles, images or frames.
    expect(html).not.toMatch(/<script|<link|<img|<iframe|style=/i)
    expect(html).toContain('<style>')
  })
})

describe('links use WEB_ORIGIN', () => {
  it('builds invite and login links from WEB_ORIGIN (trailing slash ignored)', async () => {
    const { app, signIn } = await setup(`${ORIGIN}/`)
    const me = await signIn('owner@example.com')
    const auth = { ...json, authorization: `Bearer ${me.token}` }
    const created = await (await app.request('/api/groups', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Flat', currency: 'USD', timezone: 'UTC' }) })).json() as { group: { id: string } }
    // Adding someone by email sends them an email with a link.
    await app.request(`/api/groups/${created.group.id}/people`, { method: 'POST', headers: auth, body: JSON.stringify({ displayName: 'Sam', email: 'sam@example.com' }) })
    const link = await (await app.request(`/api/groups/${created.group.id}/invite-link`, { method: 'POST', headers: auth })).json() as { url: string; token: string }
    expect(link.url).toBe(`${ORIGIN}/invite/${link.token}`)
    const outbox = await (await app.request('/api/dev/outbox')).json() as { to_email: string; body: string }[]
    const login = outbox.find((row) => row.to_email === 'owner@example.com')!
    expect(login.body).toMatch(new RegExp(`${ORIGIN.replace(/\./g, '\\.')}/login\\?token=`))
    expect(outbox.some((row) => row.to_email === 'sam@example.com')).toBe(true)
    for (const row of outbox) {
      for (const url of row.body.match(/https?:\/\/\S+/g) ?? []) expect(url.startsWith(ORIGIN), url).toBe(true)
    }
  })
})

describe('listenOptions', () => {
  it('binds all interfaces by default and HOST when set', () => {
    expect(listenOptions({})).toEqual({ port: 8787 })
    expect(listenOptions({ HOST: ' ' })).toEqual({ port: 8787 })
    expect(listenOptions({ HOST: '127.0.0.1', PORT: '9000' })).toEqual({ port: 9000, hostname: '127.0.0.1' })
  })
})
