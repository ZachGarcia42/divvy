// Browser checks for the QA chunk 2 fixes: zero-share members in the detail breakdown, "10-" in an Adjust field, the max-amount
// message, Exact input sanitizing, and the sheet's server error clearing on edit.
// Usage: NODE_PATH=<dir with playwright> node e2e/qa-chunk2.cjs http://127.0.0.1:18799 <TOKEN>
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) fails++ }
;(async () => {
  const [base, TOKEN] = process.argv.slice(2)
  const { browser, p, id, api, gid, ids, bar, type, openSheet, closeSheet, errors } = await start(base, TOKEN)
  const val = (t) => id(t).inputValue()
  // 6. header icons are centred in their round buttons (back chevron and share arrow)
  for (const [btn, icon] of [['back-to-groups', 'icon-chevron'], ['share-group-link', 'icon-share']]) {
    const bb = await id(btn).boundingBox(); const ib = await id(btn).getByTestId(icon).boundingBox()
    const dx = (ib.x + ib.width / 2) - (bb.x + bb.width / 2); const dy = (ib.y + ib.height / 2) - (bb.y + bb.height / 2)
    check(`${btn}: ${icon} is centred in the button`, Math.abs(dy) <= 0.75 && Math.abs(dx) <= 3.5, `dx=${dx.toFixed(2)} dy=${dy.toFixed(2)}`)
  }
  // 1. detail breakdown lists the $0 / 0-share members
  const made = {}
  for (const [name, split] of [
    ['QA exact', { type: 'exact', amounts: [{ participantId: ids[0], minor: 6000 }, { participantId: ids[1], minor: 4000 }] }],
    ['QA shares', { type: 'shares', parts: [{ participantId: ids[0], weight: 1 }, { participantId: ids[1], weight: 1 }] }],
  ]) {
    const r = await api(`/api/groups/${gid}/expenses`, 'POST', { description: name, originalMinor: 10000, originalCurrency: 'USD', payers: [{ participantId: ids[0], minor: 10000 }], date: new Date().toISOString().slice(0, 10), split })
    made[name] = r.expense?.id ?? r.id
    if (!made[name]) console.log('create failed', JSON.stringify(r))
  }
  await p.goto(base); await id(`group-${gid}`).click({ timeout: 3000 }).catch(() => {})
  for (const name of Object.keys(made)) {
    await id(`expense-${made[name]}`).click({ timeout: 10000 }); await id('breakdown').waitFor(); await p.waitForTimeout(300)
    const text = await id('breakdown').innerText()
    const owes = (text.match(/\$0\.00/g) ?? []).length
    check(`${name}: breakdown lists all 4 members, the two at zero owe $0.00`, owes >= 2 && /P2/.test(text) && /P3/.test(text), JSON.stringify(text))
    await id('back-to-group').click(); await p.waitForTimeout(300)
  }
  // 2. Adjust: "10-" never shows two signs
  await openSheet(); await type('expense-amount', '30'); await id('method-adjust').click()
  await type(`adjust-${ids[0]}`, '10-')
  check('Adjust "10-" shows -10 (one sign)', (await val(`adjust-${ids[0]}`)) === '-10', await val(`adjust-${ids[0]}`))
  await type(`adjust-${ids[1]}`, '5+')
  check('Adjust "5+" shows +5', (await val(`adjust-${ids[1]}`)) === '+5', await val(`adjust-${ids[1]}`))
  // 4. Exact input is sanitized
  await id('method-exact').click()
  for (const [typed, want] of [['12.345', '12.34'], ['abc', ''], ['-5', '5'], ['1,5', '1.5']]) {
    await type(`exact-${ids[0]}`, typed)
    check(`Exact "${typed}" becomes "${want}"`, (await val(`exact-${ids[0]}`)) === want, await val(`exact-${ids[0]}`))
  }
  await closeSheet()
  // 3. max amount message
  await openSheet(); await type('expense-amount', '100000.01')
  const b = await bar()
  check('$100000.01 shows the max error', /Max is \$100,000\.00/.test(b) && !/Enter an amount/.test(b), b)
  check('CTA is disabled and does not say "Enter an amount"', !/Enter an amount/.test(await id('sheet-cta').innerText()) && (await id('sheet-cta').getAttribute('aria-disabled')) === 'true')
  await type('expense-amount', '100000')
  check('$100000 is accepted', /Adds up/.test(await bar()), await bar())
  // 5. a server error clears when anything is edited
  await type('expense-amount', '12')
  let hit = 0
  await p.route('**/api/groups/*/expenses', (route) => { if (route.request().method() === 'POST') { hit++; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Server blew up', message: 'Server blew up' }) }) } return route.continue() })
  const edits = [
    ['amount', () => type('expense-amount', '13')],
    ['description', () => type('expense-description', 'x')],
    ['payer', async () => { await id('payer-chip').click(); await id(`payer-${ids[1]}`).click() }],
    ['split method', () => id('method-shares').click()],
  ]
  for (const [name, edit] of edits) {
    await id('sheet-cta').click(); await id('sheet-error').waitFor({ timeout: 5000 })
    check(`server error shows after a failed save (${name} round)`, await id('sheet-error').isVisible(), await id('sheet-error').innerText())
    await edit(); await p.waitForTimeout(250)
    check(`server error clears when the ${name} is edited`, (await id('sheet-error').count()) === 0)
  }
  check('the failing request was made each time', hit === edits.length, String(hit))
  await p.unroute('**/api/groups/*/expenses')
  check('no page errors', errors.length === 0, errors.join(';'))
  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
