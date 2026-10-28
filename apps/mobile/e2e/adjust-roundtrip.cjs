// Browser regression for the split sheet: drives the real web sheet by typing into the inputs and clicking the tabs.
// Run against a built web export + API (see apps/mobile/WEB.md). Usage: node adjust-roundtrip.cjs <BASE_URL> <TOKEN>
// Needs `playwright` and a Chrome (CHROME=/usr/bin/google-chrome). Not part of `npm test`.
const { chromium } = require('playwright')
const [base = 'http://127.0.0.1:18787', TOKEN] = process.argv.slice(2)
const api = async (path, method = 'GET', body) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return r.json() }
let failures = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) failures++ }
;(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 } })
  await ctx.addInitScript((t) => { localStorage.setItem('divvy.session', t) }, TOKEN)
  const p = await ctx.newPage(); const id = (x) => p.getByTestId(x)
  p.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++ })
  await p.goto(base); await p.getByText('Save', { exact: true }).click({ timeout: 3000 }).catch(() => {})
  let home = await api('/api/home')
  if (!home.groups.length) { await id('template-trip').click(); await id('create-group-save').click(); await id('back-to-groups').waitFor(); home = await api('/api/home') }
  const gid = home.groups[0].id
  let d = await api(`/api/groups/${gid}`)
  while (d.members.length < 4) { await api(`/api/groups/${gid}/people`, 'POST', { displayName: 'P' + d.members.length }); d = await api(`/api/groups/${gid}`) }
  const ids = [d.yourParticipantId, ...d.members.filter((m) => m.id !== d.yourParticipantId).map((m) => m.id)]
  await p.reload(); await id(`group-${gid}`).click({ timeout: 8000 }).catch(() => {}); await id('add-expense').waitFor({ timeout: 15000 })
  const bar = async () => (await id('validation-bar').innerText()).replace(/\n/g, ' | ')
  const vals = (pre) => Promise.all(ids.map((m) => id(`${pre}-${m}`).inputValue()))
  const type = async (testid, text) => { const el = id(testid); await el.click(); await el.press('Control+A'); await el.pressSequentially(text, { delay: 15 }) }
  const open = async () => { await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350); await type('expense-amount', '10.01'); await id('method-adjust').click() }
  const close = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(150); await id('discard-confirm').isVisible().then(async (v) => { if (v) await p.getByText('Discard', { exact: false }).first().click().catch(() => {}) }); await p.goto(base); await id(`group-${gid}`).click({ timeout: 8000 }).catch(() => {}); await id('add-expense').waitFor() }

  // 1. type the adjustments the way a user does, with explicit signs and zeros
  await open()
  await type(`adjust-${ids[0]}`, '+1.00'); await type(`adjust-${ids[1]}`, '+0.50'); await type(`adjust-${ids[2]}`, '0'); await type(`adjust-${ids[3]}`, '0')
  const typed = await vals('adjust'); const typedBar = await bar()
  check('typed +1.00/+0.50/0/0 is valid, no amount error', /Adds up/.test(typedBar) && !/greater than 0/.test(typedBar), typedBar)
  check('typed signs display consistently', typed[0] === '+1.00' && typed[1] === '+0.50', JSON.stringify(typed))
  // 2. the round trips
  for (const via of [['percent'], ['percent', 'shares'], ['exact'], ['shares', 'exact', 'percent']]) {
    for (const m of via) await id(`method-${m}`).click()
    await id('method-adjust').click(); await p.waitForTimeout(100)
    const back = await vals('adjust'); const bb = await bar()
    check(`Adjust > ${via.join(' > ')} > Adjust restores the typed inputs`, JSON.stringify(back) === JSON.stringify(typed) && /Adds up/.test(bb), `${JSON.stringify(back)} ${bb}`)
  }
  await close()
  // 3. an invalid / half-typed Adjust is not dropped by a round trip either
  await open()
  await type(`adjust-${ids[0]}`, '+1.00'); await type(`adjust-${ids[1]}`, '99')
  const bad = await vals('adjust'); const badBar = await bar()
  for (const m of ['percent', 'shares']) await id(`method-${m}`).click()
  await id('method-adjust').click(); await p.waitForTimeout(100)
  const badBack = await vals('adjust')
  check('over-large adjustments survive Adjust > % > Shares > Adjust', JSON.stringify(badBack) === JSON.stringify(bad), `${JSON.stringify(bad)} -> ${JSON.stringify(badBack)} (${badBar})`)
  await close()
  // 4. sign button and typing agree
  await open()
  await type(`adjust-${ids[0]}`, '2'); await id(`adjust-sign-${ids[0]}`).click()
  check('sign button flips to a visible minus', (await id(`adjust-${ids[0]}`).inputValue()) === '-2', await id(`adjust-${ids[0]}`).inputValue())
  await type(`adjust-${ids[1]}`, '-0.50'); await type(`adjust-${ids[2]}`, '.5')
  const v = await vals('adjust'); check('typed minus and leading dot are accepted', v[1] === '-0.50' && /Adds up/.test(await bar()), JSON.stringify(v) + ' ' + await bar())
  await close()
  await b.close()
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0)
})()
