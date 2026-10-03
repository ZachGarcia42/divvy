import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createSql } from './db.ts'

const sql = await createSql()
const { app, repo } = createApp(sql)
const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, () => {
  console.log(`Divvy API listening on http://localhost:${port}`)
})

const tick = () => {
  repo.tickRecurrences().catch((error) => {
    console.error('recurrence tick failed', error)
  })
}
tick()
setInterval(tick, 60_000)
