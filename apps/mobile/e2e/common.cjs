// Shared setup for the browser scripts in this folder: a signed-in page on the built web export, a group with 4 people,
// and helpers that type like a person (click, select all, type) and read the validation bar.
const { chromium } = require('playwright')
exports.start = async function start(base, TOKEN, { viewport = { width: 420, height: 900 }, members = 4 } = {}) {
  const api = async (path, method = 'GET', body) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return r.json() }
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const ctx = await browser.newContext({ viewport })
  await ctx.addInitScript((t) => { localStorage.setItem('divvy.session', t) }, TOKEN)
  const p = await ctx.newPage()
  const id = (x) => p.getByTestId(x)
  const errors = []
  p.on('pageerror', (e) => { console.log('PAGEERROR', e.message); errors.push(e.message) })
  let home = await api('/api/home')
  if (!home.groups.length) { await api('/api/groups', 'POST', { name: 'Tahoe', currency: 'USD', timezone: 'America/Los_Angeles' }); home = await api('/api/home') }
  const gid = home.groups[0].id
  let d = await api(`/api/groups/${gid}`)
  while (d.members.length < members) { await api(`/api/groups/${gid}/people`, 'POST', { displayName: 'P' + d.members.length }); d = await api(`/api/groups/${gid}`) }
  const ids = [d.yourParticipantId, ...d.members.filter((m) => m.id !== d.yourParticipantId).map((m) => m.id)]
  await p.goto(base); await p.getByText('Save', { exact: true }).click({ timeout: 3000 }).catch(() => {})
  await id(`group-${gid}`).click({ timeout: 8000 }).catch(() => {}); await id('add-expense').waitFor({ timeout: 15000 })
  const bar = async () => (await id('validation-bar').innerText()).replace(/\n/g, ' | ')
  const type = async (testid, text, delay = 15) => { const el = id(testid); await el.click(); await el.press('Control+A'); await el.pressSequentially(text, { delay }) }
  const openSheet = async () => { await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350) }
  const closeSheet = async () => {
    await p.keyboard.press('Escape'); await p.waitForTimeout(200)
    if (await id('discard-yes').isVisible().catch(() => false)) await id('discard-yes').click()
    await p.waitForTimeout(200)
  }
  return { browser, ctx, p, id, api, gid, ids, bar, type, openSheet, closeSheet, errors }
}
