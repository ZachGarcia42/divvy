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
    expect(csp).toContain("img-src 'self' data: https:")
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
