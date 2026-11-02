// Local stack for multi-currency.cjs: the API on an in-memory database, the web export, and a fake Frankfurter the API
// really calls (so the real fetch, cache and weekend logic run). Control the fake: GET :FAKE_PORT/__down?on=1 simulates an outage.
// Usage (from apps/api, so tsx resolves): DIST=<web export dir> npx tsx ../mobile/e2e/serve-fx.mts   -> prints TOKEN, then "up"
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { createApp } from '../../api/src/app.ts'
import { createMemorySql } from '../../api/src/db.ts'
import { sessionFor } from '../../api/src/testkit.ts'

const PORT = Number(process.env.PORT ?? 18799)
const FAKE_PORT = Number(process.env.FAKE_PORT ?? 18798)
const DIST = process.env.DIST!
// ECB-like fixing per business day; weekends fall back to Friday the way the real source does.
const table: Record<string, Record<string, number>> = {
  'EUR:USD': { '2026-10-26': 1.05, '2026-10-27': 1.055, '2026-10-28': 1.06, '2026-10-29': 1.07, '2026-10-30': 1.0765 },
  'JPY:USD': { '2026-10-26': 0.0066, '2026-10-27': 0.0066, '2026-10-28': 0.0066, '2026-10-29': 0.0066, '2026-10-30': 0.0066 },
}
let down = false
let hits = 0
const fake = new Hono()
fake.get('/__down', (c) => { down = c.req.query('on') === '1'; return c.json({ down }) })
fake.get('/__hits', (c) => c.json({ hits }))
fake.get('/v1/:date', (c) => {
  hits++
  if (down) return c.text('down', 503)
  const date = c.req.param('date')
  const rates = table[`${c.req.query('base')}:${c.req.query('symbols')}`]
  const days = rates ? Object.keys(rates).sort().filter((d) => d <= date) : []
  if (!days.length) return c.json({ message: 'not found' }, 404)
  const day = days[days.length - 1]
  return c.json({ amount: 1, base: c.req.query('base'), date: day, rates: { [c.req.query('symbols')!]: rates[day] } })
})
serve({ fetch: fake.fetch, port: FAKE_PORT, hostname: '127.0.0.1' })

process.env.FX_API_BASE = `http://127.0.0.1:${FAKE_PORT}/v1`
const sql = await createMemorySql()
const { app: api } = createApp(sql, { dev: true })
const token = await sessionFor(api, 'zach@example.com')
console.log('TOKEN', token)
const root = new Hono()
root.all('/api/*', (c) => api.fetch(c.req.raw))
root.use('/*', serveStatic({ root: DIST }))
root.get('*', (c) => c.html(readFileSync(`${DIST}/index.html`, 'utf8')))
serve({ fetch: root.fetch, port: PORT, hostname: '127.0.0.1' }, () => console.log('up'))
