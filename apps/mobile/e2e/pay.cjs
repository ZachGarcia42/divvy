// Browser check for payment links on the web build: Account → Payment names (validation, save, clear), the Settle up
// "Pay <name> with" rows and their links, the currency rule, the owed-side nudge, and that nothing is ever recorded without a tap.
// Usage: NODE_PATH=<dir with playwright> node e2e/pay.cjs http://127.0.0.1:18822 <ZACH_TOKEN> <MAYA_TOKEN>
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) fails++ }
const today = () => new Date().toISOString().slice(0, 10)

;(async () => {
  const [base, ZACH, MAYA] = process.argv.slice(2)
  const { browser, ctx, p, id, api, gid, errors } = await start(base, ZACH, { members: 2 })
  const mayaApi = async (path, method = 'GET', body) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${MAYA}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) } }
  const opened = []
  await ctx.exposeFunction('__opened', (url) => { opened.push(url) })
  await ctx.addInitScript(() => { window.open = (url) => { window.__opened(String(url)); return null } })
  await p.reload(); await id(`group-${gid}`).click({ timeout: 8000 }).catch(() => {}); await id('add-expense').waitFor({ timeout: 15000 })

  // Maya joins Zach's group and pays for something Zach shares.
  const link = await api(`/api/groups/${gid}/invite-link`, 'POST')
  const joined = await mayaApi(`/api/invites/${link.token}/accept`, 'POST')
  check('Maya joined the group', joined.status === 200)
  const d0 = await api(`/api/groups/${gid}`)
  const mayaId = d0.members.find((m) => m.name === 'Maya').id
  const you = d0.yourParticipantId
  const made = await mayaApi(`/api/groups/${gid}/expenses`, 'POST', { description: 'Dinner', originalMinor: 8500, originalCurrency: 'USD', date: today(), payers: [{ participantId: mayaId, minor: 8500 }], split: { type: 'equal', participantIds: [you, mayaId] } })
  check('Maya added a $85 dinner split with you', made.status === 200 || made.status === 201, JSON.stringify(made.json).slice(0, 120))
  const settlementsOf = async () => (await api(`/api/groups/${gid}`)).settlements.length

  const goSettle = async () => { await p.goto(base); await id(`group-${gid}`).click({ timeout: 8000 }).catch(() => {}); await id('add-expense').waitFor(); await id('settle-up').click({ timeout: 8000 }); await id('settle-card').waitFor() }

  // 1. Maya has no payment names yet: no buttons, one calm row, Record still there.
  await goSettle()
  check('payer, no names: "hasn\'t added" row and no pay buttons', await id('pay-none').isVisible() && (await id('pay-venmo').count()) === 0)
  check('Record is still offered', await id(`record-${you}-${mayaId}`).isVisible())

  // 2. Your own names: Account → Payment names, validation and save.
  await p.goto(base); await id(`group-${gid}`).click({ timeout: 8000 }).catch(() => {}); await id('tab-account').click()
  check('Account has a Payment names row that says none are set', /Add Venmo, PayPal or Cash App/.test(await id('pay-names-summary').innerText()))
  await id('pay-names-row').click(); await id('paynames-venmo').waitFor()
  await id('paynames-venmo').fill('abc'); await id('paynames-paypal').fill('pay pal'); await id('paynames-cashapp').fill('1234')
  await id('paynames-save').click(); await p.waitForTimeout(300)
  check('bad handles show their message and nothing is saved', /5–30/.test(await id('paynames-venmo-hint').innerText()) && /letters and numbers/.test(await id('paynames-paypal-hint').innerText()) && /cashtag/.test(await id('paynames-cashapp-hint').innerText()) && Object.keys((await api('/api/home')).you.pay).length === 0)
  await id('paynames-venmo').fill('@zach-g'); await id('paynames-paypal').fill('zachg'); await id('paynames-cashapp').fill('')
  await id('paynames-save').click(); await id('pay-names-row').waitFor({ timeout: 5000 })
  const mine = (await api('/api/home')).you.pay
  check('saved with the @ stripped and the empty one left out', mine.venmo === 'zach-g' && mine.paypal === 'zachg' && !('cashapp' in mine), JSON.stringify(mine))
  check('Account summary lists Venmo · PayPal', /Venmo · PayPal/.test(await id('pay-names-summary').innerText()))

  // 3. Maya sets hers; Zach pays her on Settle up.
  const setMaya = await mayaApi('/api/me', 'PATCH', { pay: { venmo: '@maya-r', paypal: 'mayar', cashapp: '$mayar' } })
  check('Maya saved her names', setMaya.status === 200)
  await goSettle()
  check('three pay rows for a USD group', (await id('pay-venmo').count()) === 1 && (await id('pay-paypal').count()) === 1 && (await id('pay-cashapp').count()) === 1)
  check('Venmo row says what it opens', /@maya-r · opens Venmo with \$42\.50 filled in/.test(await id('pay-venmo').innerText()))
  check('ghost button reads "I paid another way · Record $42.50"', /I paid another way · Record \$42\.50/.test(await id(`record-${you}-${mayaId}`).innerText()))
  check('no brand logos: rows hold text only', (await p.locator('[data-testid^="pay-"] img').count()) === 0)

  // 4. Links
  await id('pay-venmo').click(); await p.waitForTimeout(200)
  check('Venmo opens the web pay page with amount, note and private audience', opened.at(-1) === 'https://account.venmo.com/pay?txn=pay&recipients=%2Cmaya-r&amount=42.50&note=Divvy%3A%20Tahoe&audience=private', opened.at(-1))
  await id('pay-paypal').click(); await p.waitForTimeout(200)
  check('PayPal opens paypal.me with amount and currency', opened.at(-1) === 'https://paypal.me/mayar/42.50USD', opened.at(-1))
  await id('pay-cashapp').click(); await p.waitForTimeout(200)
  check('Cash App opens cash.app with the amount', opened.at(-1) === 'https://cash.app/$mayar/42.50', opened.at(-1))
  check('opening a link records nothing', (await settlementsOf()) === 0)

  // 5. The amount shown is the amount linked.
  await id('settle-amount').click(); await id('settle-amount').press('Control+A'); await id('settle-amount').pressSequentially('10', { delay: 10 })
  await p.waitForTimeout(200)
  await id('pay-venmo').click(); await p.waitForTimeout(200)
  check('a part payment links the part amount', /amount=10\.00&/.test(opened.at(-1)), opened.at(-1))
  await id('settle-amount').press('Control+A'); await id('settle-amount').pressSequentially('999', { delay: 10 }); await p.waitForTimeout(200)
  check('an amount over what is owed hides the pay rows', (await id('pay-venmo').count()) === 0)
  await id('settle-amount').press('Control+A'); await id('settle-amount').pressSequentially('42.50', { delay: 10 }); await p.waitForTimeout(200)

  // 6. Coming back from the other app: the sheet asks, never records by itself.
  await id('pay-venmo').click(); await p.waitForTimeout(100)
  const hide = () => p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  const show = () => p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')) })
  await show(); await p.waitForTimeout(300)
  check('a quick bounce without leaving asks nothing', (await id('pay-return').count()) === 0)
  await hide(); await p.waitForTimeout(1700); await show()
  await id('pay-return').waitFor({ timeout: 5000 })
  const asked = await id('pay-return').innerText()
  check('asks "Did you send Maya $42.50 on Venmo?"', /Did you send Maya \$42\.50 on Venmo\?/.test(asked))
  check('copy never claims it was paid or confirmed', !/\b(paid|confirmed)\b/i.test(asked.replace(/I paid another way/i, '')))
  check('the question alone records nothing', (await settlementsOf()) === 0)
  await id('pay-return-not-yet').click(); await p.waitForTimeout(500)
  check('"Not yet" closes it and records nothing', (await id('pay-return').count()) === 0 && (await settlementsOf()) === 0)
  await id('pay-venmo').click(); await p.waitForTimeout(100); await hide(); await p.waitForTimeout(1700); await show(); await id('pay-return').waitFor({ timeout: 5000 })
  await id('pay-return-different').click(); await p.waitForTimeout(500)
  check('"Pay a different amount" returns to the amount and records nothing', (await id('pay-return').count()) === 0 && await id('settle-amount').isVisible() && (await settlementsOf()) === 0)
  await id('pay-venmo').click(); await p.waitForTimeout(100); await hide(); await p.waitForTimeout(1700); await show(); await id('pay-return').waitFor({ timeout: 5000 })
  await id('pay-return-yes').click(); await p.waitForTimeout(1200)
  const after = await api(`/api/groups/${gid}`)
  check('"Yes, record $42.50" records exactly that, once', after.settlements.length === 1 && after.settlements[0].minor === 4250 && after.settlements[0].fromId === you && after.settlements[0].toId === mayaId, JSON.stringify(after.settlements.map((s) => s.minor)))

  // 7. Owed side: Maya is paid back on a new bill; she has names so no nudge; Zach clears his and sees the nudge.
  await mayaApi(`/api/groups/${gid}/expenses`, 'POST', { description: 'Taxi', originalMinor: 3000, originalCurrency: 'USD', date: today(), payers: [{ participantId: you, minor: 3000 }], split: { type: 'equal', participantIds: [you, mayaId] } })
  await api('/api/me', 'PATCH', { pay: { venmo: null, paypal: '', cashapp: null } })
  await goSettle()
  check('owed: the "Get paid in one tap" nudge shows when you have no names', await id('pay-nudge').isVisible() && (await id('pay-venmo').count()) === 0)
  check('owed: the note says to record once they pay', /Once Maya pays you, record it here/.test(await id('no-money-notice').innerText()))
  await id('pay-nudge-add').click(); await id('paynames-venmo').waitFor({ timeout: 5000 })
  check('"Add payment names" opens the form', true)

  // 8. Server side: handles go to people in the group only.
  const stranger = await fetch(base + '/api/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', 'x-divvy-platform': 'ios' }, body: JSON.stringify({ email: 'zed@example.com' }) }).then((r) => r.json())
  const verified = await fetch(base + '/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-divvy-platform': 'ios' }, body: JSON.stringify({ token: stranger.devToken }) }).then((r) => r.json())
  const peek = await fetch(`${base}/api/groups/${gid}`, { headers: { authorization: `Bearer ${verified.token}` } })
  check('a signed-in stranger gets no group and so no handles', peek.status !== 200 && !(await peek.text()).includes('maya-r'), String(peek.status))

  check('no page errors', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
})().catch((e) => { console.log('CRASH', e); process.exit(2) })
