// Local server for e2e/photos.cjs: the API with an in-memory database, a temp photo dir, and the web export.
// Usage (from repo root): npx tsx apps/mobile/e2e/photos-server.mts   -> prints TOKEN, then "up"
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../..', import.meta.url))
const { createApp } = await import(`${root}/apps/api/src/app.ts`)
const { createMemorySql } = await import(`${root}/apps/api/src/db.ts`)
const { sessionFor } = await import(`${root}/apps/api/src/testkit.ts`)
const sql = await createMemorySql()
const photoDir = mkdtempSync(join(tmpdir(), 'divvy-e2e-photos-'))
const { app: api } = createApp(sql, { dev: true, rateFor: async () => '1', photoDir })
const token = await sessionFor(api, 'zach@example.com')
console.log('TOKEN', token)
const web = `${root}/apps/mobile/dist-web`
const server = new Hono()
server.all('/api/*', (c) => api.fetch(c.req.raw))
server.use('/*', serveStatic({ root: web }))
server.get('*', (c) => c.html(readFileSync(`${web}/index.html`, 'utf8')))
serve({ fetch: server.fetch, port: Number(process.env.PORT ?? 18821), hostname: '127.0.0.1' }, () => console.log('up'))
