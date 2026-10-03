import { LedgerError } from '@divvy/domain'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Sql } from './db.ts'
import { Repo } from './repo.ts'

const COOKIE = 'divvy_session'

export function createApp(sql: Sql, options?: {
  now?: () => Date
  rateFor?: (from: string, to: string, date: string) => Promise<string>
  webOrigin?: string
  dev?: boolean
}) {
  const dev = options?.dev ?? process.env.NODE_ENV !== 'production'
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
    if (error instanceof LedgerError) {
      const status = error.code === 'UNAUTHENTICATED' || error.code === 'BAD_TOKEN' ? 401
        : error.code === 'FORBIDDEN' || error.code === 'SUSPENDED' || error.code === 'BLOCKED' ? 403
        : error.code === 'NOT_FOUND' ? 404
        : error.code === 'STALE' ? 409
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

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.post('/api/auth/magic-link', async (c) => {
    const body = await c.req.json<{ email: string }>()
    const issued = await repo.requestMagicLink(body.email)
    return c.json({ ok: true, devToken: dev ? issued.token : undefined })
  })

  app.post('/api/auth/verify', async (c) => {
    const body = await c.req.json<{ token: string }>()
    const result = await repo.verifyMagicLink(body.token)
    setCookie(c, COOKIE, result.token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30 })
    return c.json(result)
  })

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
  app.patch('/api/me', async (c) => c.json(await repo.updateMe(await actor(c), await c.req.json())))
  app.post('/api/me/email', async (c) => {
    const current = await actor(c)
    const body = await c.req.json<{ email: string }>()
    const issued = await repo.requestMagicLink(body.email, 'email_change', current.userId)
    return c.json({ ok: true, devToken: dev ? issued.token : undefined })
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
    const body = await c.req.json<{ targetType: string; targetId: string; body: string }>()
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
    if (!dev) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
    const result = await repo.seed()
    setCookie(c, COOKIE, result.token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30 })
    return c.json(result)
  })
  app.get('/api/dev/outbox', async (c) => {
    if (!dev) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
    return c.json(await repo.outbox())
  })
  app.post('/api/admin/users/:id/suspend', async (c) => {
    const expected = process.env.ADMIN_TOKEN ?? (dev ? 'dev-admin' : '')
    if (!expected || c.req.header('x-admin-token') !== expected) {
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
