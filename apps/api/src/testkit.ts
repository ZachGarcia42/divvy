import { createApp } from './app.ts'
import { createMemorySql } from './db.ts'

export async function sessionFor(app: ReturnType<typeof createApp>['app'], email: string) {
  const started = await app.request('/api/auth/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-divvy-platform': 'ios' },
    body: JSON.stringify({ email }),
  })
  const issued = await started.json() as { devToken: string }
  const verified = await app.request('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-divvy-platform': 'ios' },
    body: JSON.stringify({ token: issued.devToken }),
  })
  const body = await verified.json() as { token: string }
  return body.token
}

/** A group of Alex (signed in) plus the named people, with a tiny fetch helper. */
export async function groupOf(names: string[], now = '2026-10-27T15:00:00Z') {
  const sql = await createMemorySql()
  const { app } = createApp(sql, { now: () => new Date(now), dev: true, rateFor: async () => '1' })
  const token = await sessionFor(app, 'alex@example.com')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-divvy-platform': 'ios' }
  const call = async <T = any>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const json = await res.json().catch(() => null) as T
    return { status: res.status, json }
  }
  const created = (await call<{ group: { id: string }; members: { id: string }[] }>('POST', '/api/groups', { name: 'Trip', currency: 'USD', timezone: 'UTC' })).json
  const groupId = created.group.id
  const ids = [created.members[0]!.id]
  for (const name of names) {
    const added = await call<{ participantId: string }>('POST', `/api/groups/${groupId}/people`, { displayName: name })
    ids.push(added.json.participantId)
  }
  const detail = async () => (await call('GET', `/api/groups/${groupId}`)).json
  return { sql, app, call, groupId, ids, detail }
}
