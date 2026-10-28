import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp, HTML_CSP } from './app.ts'
import { createMemorySql } from './db.ts'
import { APP_CSP } from './web.ts'

const T = 'abcdefghijklmnopqrst'
const SHELL = '<!doctype html><div id="root"></div><script src="/_expo/static/js/web/index-abc123.js" defer></script>'

function dist() {
  const dir = mkdtempSync(join(tmpdir(), 'divvy-web-'))
  mkdirSync(join(dir, '_expo/static/js/web'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), SHELL)
  writeFileSync(join(dir, '_expo/static/js/web/index-abc123.js'), 'console.log(1)')
  writeFileSync(join(dir, 'metadata.json'), '{}')
  writeFileSync(join(dir, '..', 'secret-divvy-web.txt'), 'nope')
  return dir
}
async function setup(webDist: string | null = dist()) {
  const { app } = createApp(await createMemorySql(), { dev: true, rateFor: async () => '1', devSigninEmails: null, rateLimit: false, webOrigin: 'https://divvy.mooo.com', webDist })
  return app
}

describe('web app static serving', () => {
  it('serves the app shell at / with the app CSP and no-cache', async () => {
    const app = await setup()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe(SHELL)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toBe(APP_CSP)
    expect(csp).toContain("script-src 'self' https://accounts.google.com/gsi/client")
    expect(csp).toContain('frame-src https://accounts.google.com/gsi/')
    expect(csp).toContain("connect-src 'self' https://accounts.google.com/gsi/")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("img-src 'self' data: https://lh3.googleusercontent.com;")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-eval')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('caches hashed assets for a year with the right type', async () => {
    const app = await setup()
    const res = await app.request('/_expo/static/js/web/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toBe('console.log(1)')
    expect((await app.request('/metadata.json')).headers.get('cache-control')).toBe('no-cache')
    const head = await app.request('/_expo/static/js/web/index-abc123.js', { method: 'HEAD' })
    expect(head.status).toBe(200)
  })

  it('falls back to index.html for app routes, but 404s missing files and traversal', async () => {
    const app = await setup()
    for (const path of ['/groups/123', '/app/invite/' + T, '/app/login?token=' + T, '/settings/']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(200)
      expect(await res.text()).toBe(SHELL)
    }
    for (const path of ['/missing.js', '/_expo/static/js/web/gone', '/..%2Fsecret-divvy-web.txt', '/%2e%2e/secret-divvy-web.txt', '/a%5c..%5c..%5csecret-divvy-web.txt', '/%E0%A4%A']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(404)
      expect(await res.text()).not.toContain('nope')
    }
  })

  it('leaves /api alone', async () => {
    const app = await setup()
    const health = await app.request('/api/health')
    expect(health.headers.get('content-type')).toContain('application/json')
    expect(await health.json()).toMatchObject({ ok: true })
    expect(health.headers.get('referrer-policy')).toBe('no-referrer')
    const unknown = await app.request('/api/nope')
    expect(unknown.status).toBe(404)
    expect(await unknown.text()).not.toBe(SHELL)
    expect((await app.request('/api')).status).toBe(404)
  })

  it('keeps the landing pages and links them into the web app', async () => {
    const app = await setup()
    const invite = await app.request(`/invite/${T}`)
    expect(invite.status).toBe(200)
    expect(invite.headers.get('content-security-policy')).toBe(HTML_CSP)
    const html = await invite.text()
    expect(html).toContain(`href="divvy://invite/${T}"`)
    expect(html).toContain(`href="/app/invite/${T}"`)
    expect(html).toContain(`<a class="button secondary" href="/app/invite/${T}">Continue on the web</a>`)
    expect(html).toContain("a.button.secondary{background:#f3faf7")
    const login = await (await app.request(`/login?token=${T}&next=${encodeURIComponent('/invite/abc')}`)).text()
    expect(login).toContain(`href="/app/login?token=${T}&amp;next=%2Finvite%2Fabc"`)
    expect((await app.request('/invite/x')).status).toBe(400)
  })

  it('is off without WEB_DIST: / stays 404 and landing pages have no web link', async () => {
    const app = await setup(null)
    expect((await app.request('/')).status).toBe(404)
    expect(await (await app.request(`/invite/${T}`)).text()).not.toContain('/app/invite/')
  })
})

describe('web hardening (QA bcde11a)', () => {
  it('404s dotfiles, traversal (raw and encoded) and odd paths instead of the SPA shell', async () => {
    const dir = dist()
    writeFileSync(join(dir, '.env'), 'SECRET=x')
    const { createWebDist } = await import('./web.ts')
    const web = createWebDist(dir)
    for (const path of ['/.env', '/.git/config', '/app/.hidden', '/../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/%2E%2E/secret-divvy-web.txt', '/..%2fsecret-divvy-web.txt', '/a%20b', '/app//x', '/~root']) {
      const found = await web.serve(path)
      expect(found?.status, path).toBe(404)
    }
    for (const path of ['/', '/app', '/app/groups/abc-123', '/invite/Ab_12']) expect((await web.serve(path))?.status, path).toBe(200)
    const app = await setup(dir)
    expect((await app.request('/.env')).status).toBe(404)
    // As served by @hono/node-server: the raw target arrives in env.incoming.url while c.req.url is normalized.
    for (const raw of ['/%2e%2e/%2e%2e/etc/passwd', '/../etc/passwd', '/app/../.env']) {
      expect((await app.request(raw, {}, { incoming: { url: raw } })).status, raw).toBe(404)
    }
    expect((await app.request('/app/groups/x', {}, { incoming: { url: '/app/groups/x?a=1' } })).status).toBe(200)
  })
  it('answers /api, /api/ and unknown /api/* with a JSON 404', async () => {
    const app = await setup()
    for (const path of ['/api', '/api/', '/api/nope', '/api/nope/deeper']) {
      for (const method of ['GET', 'POST']) {
        const res = await app.request(path, { method })
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.headers.get('content-type')).toContain('application/json')
        expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } })
      }
    }
    expect((await app.request('/api/health')).status).toBe(200)
  })
  it('narrows img-src to self, data: and the Google avatar host', () => {
    expect(APP_CSP).toContain("img-src 'self' data: https://lh3.googleusercontent.com;")
    expect(APP_CSP).not.toMatch(/img-src[^;]*https:(?!\/\/lh3)/)
  })
})

describe('dev tester sign-in is native-only', () => {
  const post = (app: Awaited<ReturnType<typeof setup>>, path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const make = async () => createApp(await createMemorySql(), { dev: true, rateFor: async () => '1', devSigninEmails: 'tester@example.com', rateLimit: false }).app
  it('never issues a devToken to a browser, a web/unknown platform, or a request with no platform header', async () => {
    const app = await make()
    for (const headers of [
      {},
      { 'x-divvy-platform': '' },
      { 'x-divvy-platform': 'web' },
      { 'x-divvy-platform': 'bogus' },
      { 'x-divvy-platform': 'windows' },
      { origin: 'https://divvy.mooo.com' },
      { 'sec-fetch-site': 'same-origin' },
      { 'x-divvy-platform': 'ios', origin: 'https://divvy.mooo.com' },
      { 'x-divvy-platform': 'android', origin: 'https://divvy.mooo.com' },
      { 'x-divvy-platform': 'ios', 'sec-fetch-site': 'cross-site' },
      { 'x-divvy-platform': 'android', 'sec-fetch-mode': 'cors' },
    ] as Record<string, string>[]) {
      const body = await (await post(app, '/api/auth/magic-link', { email: 'tester@example.com' }, headers)).json() as { devToken?: string; devCode?: string }
      expect(body.devToken, JSON.stringify(headers)).toBeUndefined()
      expect(body.devCode, JSON.stringify(headers)).toBeUndefined()
    }
    for (const headers of [{}, { 'x-divvy-platform': 'web' }] as Record<string, string>[]) {
      const providers = await (await app.request('/api/auth/providers', { headers })).json() as { email: boolean }
      expect(providers.email, JSON.stringify(headers)).toBe(false)
    }
  })
  it('issues and verifies a devToken only for ios/android without browser headers', async () => {
    const app = await make()
    for (const headers of [{ 'x-divvy-platform': 'ios' }, { 'x-divvy-platform': 'android' }, { 'x-divvy-platform': ' IOS ' }] as Record<string, string>[]) {
      const issued = await (await post(app, '/api/auth/magic-link', { email: 'tester@example.com' }, headers)).json() as { devToken?: string }
      expect(issued.devToken, JSON.stringify(headers)).toBeTruthy()
      expect((await post(app, '/api/auth/verify', { token: issued.devToken }, headers)).status).toBe(200)
    }
    expect(((await (await app.request('/api/auth/providers', { headers: { 'x-divvy-platform': 'ios' } })).json()) as { email: boolean }).email).toBe(true)
  })
  it('refuses a dev-issued token presented from a browser', async () => {
    const app = await make()
    const issued = await (await post(app, '/api/auth/magic-link', { email: 'tester@example.com' }, { 'x-divvy-platform': 'android' })).json() as { devToken: string }
    expect((await post(app, '/api/auth/verify', { token: issued.devToken }, { 'x-divvy-platform': 'web' })).status).toBe(401)
    expect((await post(app, '/api/auth/verify', { token: issued.devToken }, { origin: 'https://divvy.mooo.com' })).status).toBe(401)
  })
})
