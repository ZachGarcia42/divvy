import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { checkStartupEnv, listenOptions } from './config.ts'
import { createSql } from './db.ts'

const startup = checkStartupEnv(process.env)
if (!startup.ok) {
  console.error(`\nDivvy API refused to start: ${startup.error}\n`)
  process.exit(1)
}
for (const warning of startup.warnings) console.warn(`\n${'!'.repeat(72)}\n${warning}\n${'!'.repeat(72)}\n`)

const sql = await createSql()
const { app, repo } = createApp(sql)
const listen = listenOptions(process.env)

serve({ fetch: app.fetch, ...listen }, () => {
  console.log(`Divvy API listening on http://${listen.hostname ?? 'localhost'}:${listen.port}`)
})

const tick = () => {
  repo.tickRecurrences().catch((error) => {
    console.error('recurrence tick failed', error)
  })
}
tick()
setInterval(tick, 60_000)
