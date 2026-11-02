// Local server for e2e/pay.cjs: the API with an in-memory database plus the web export, on one port. Run from the repo:
//   npx tsx apps/mobile/e2e/pay-server.mts   (prints the two sign-in tokens)
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../..', import.meta.url))
const { createApp } = await import(`${root}/apps/api/src/app.ts`)
const { createMemorySql } = await import(`${root}/apps/api/src/db.ts`)
const { sessionFor } = await import(`${root}/apps/api/src/testkit.ts`)
const sql = await createMemorySql()
const { app: api } = createApp(sql, { dev: true, rateFor: async () => '1' })
const zach = await sessionFor(api, 'zach@example.com')
const maya = await sessionFor(api, 'maya@example.com')
console.log('TOKENS', zach, maya)
const web = `${root}/apps/mobile/dist-web`
const server = new Hono()
server.all('/api/*', (c) => api.fetch(c.req.raw))
server.use('/*', serveStatic({ root: web }))
server.get('*', (c) => c.html(readFileSync(`${web}/index.html`, 'utf8')))
serve({ fetch: server.fetch, port: Number(process.env.PORT ?? 18822), hostname: '127.0.0.1' }, () => console.log('up'))
