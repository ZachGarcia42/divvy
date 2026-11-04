// Browser checks for the "next polish" round: browser Back closes the add sheet (and the layers inside it) first, Forward works, a reload
// leaves no stray history, two quick Backs from Settle up stay on the site, "See all" + Back returns to Activity, the sections reply falling
// back to the flat feed (junk, empty, 404, HTML), the contrast colours, the one-line Adjust error, the currency sheet and the rate-error state.
// Usage: NODE_PATH=<dir with playwright> node e2e/next-polish.cjs http://127.0.0.1:18799 <TOKEN> [http://127.0.0.1:18798] [shotdir]
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : extra); if (!ok) fails++ }
;(async () => {
  const [base, TOKEN, fake = 'http://127.0.0.1:18798', shots] = process.argv.slice(2)
  const { browser, p, id, api, gid, ids, type, errors } = await start(base, TOKEN, { viewport: { width: 390, height: 800 }, members: 4 })
  const now = new Date(); const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  for (let i = 0; i < 3; i++) {
    const r = await api(`/api/groups/${gid}/expenses`, 'POST', { description: `Dinner ${i}`, date: day, originalMinor: 4000 + i * 100, originalCurrency: 'USD', payers: [{ participantId: ids[1 + (i % 3)], minor: 4000 + i * 100 }], split: { type: 'equal', participantIds: [ids[0], ids[1 + (i % 3)]] } })
    if (!r.id) throw new Error(`could not add: ${JSON.stringify(r)}`)
  }
  const here = () => p.url()
  const onSite = () => here().startsWith(base)
  // A fresh history: about:blank first, so one Back too many is visible as leaving the site.
  // The app reopens the last group on load, so go up to Groups with its own button when it did.
  const fresh = async () => {
    await p.goto('about:blank'); await p.goto(base)
    await p.waitForSelector(`[data-testid="group-${gid}"], [data-testid="add-expense"]`, { timeout: 15000 })
    if (await id('add-expense').isVisible().catch(() => false)) await id('back-to-groups').click()
    await id(`group-${gid}`).waitFor({ timeout: 15000 }); await p.waitForTimeout(300)
  }
  const openGroup = async () => { await id(`group-${gid}`).click(); await id('add-expense').waitFor({ timeout: 10000 }); await p.waitForTimeout(250) }
  const feedRow = '[data-testid^="feed-"][role="button"]'

  // ── Back closes the add sheet first ──
  await fresh(); await openGroup()
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350)
  await p.goBack(); await p.waitForTimeout(400)
  check('Back with the add sheet open closes the sheet, not the group', onSite() && (await id('add-sheet').count()) === 0 && await id('add-expense').isVisible())
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350)
  await type('expense-amount', '25'); await id('currency-chip').click(); await id('currency-sheet').waitFor(); await p.waitForTimeout(300)
  await p.goBack(); await p.waitForTimeout(400)
  check('Back with the currency list open closes the list first, the sheet stays', (await id('currency-sheet').count()) === 0 && (await id('add-sheet').count()) === 1)
  await id('currency-chip').click(); await id('currency-sheet').waitFor(); await p.waitForTimeout(200)
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  check('Escape with the currency list open closes only the list', (await id('currency-sheet').count()) === 0 && (await id('add-sheet').count()) === 1)
  await id('date-chip').click(); await id('date-picker').waitFor(); await p.waitForTimeout(200)
  await p.goBack(); await p.waitForTimeout(400)
  check('Back with the calendar open closes the calendar first, the sheet stays', (await id('date-picker').count()) === 0 && (await id('add-sheet').count()) === 1)
  await p.goBack(); await p.waitForTimeout(400)
  check('a second Back with a typed amount asks before discarding (still on the site)', onSite() && (await id('discard-yes').isVisible().catch(() => false) || (await id('add-sheet').count()) === 0))
  if (await id('discard-yes').isVisible().catch(() => false)) await id('discard-yes').click()
  await p.waitForTimeout(300)
  check('discarding returns to the group', await id('add-expense').isVisible())

  // ── Forward moves on ──
  await p.goBack(); await p.waitForTimeout(400)
  check('Back from the group returns to Groups', onSite() && await id('tab-activity').isVisible())
  await p.goForward(); await p.waitForTimeout(500)
  check('Forward returns to the group', onSite() && await id('add-expense').isVisible())

  // ── one Back from Groups after a reload leaves the site ──
  await fresh(); await openGroup(); await p.reload(); await p.waitForTimeout(1500)
  await p.waitForSelector('[data-testid="tab-activity"], [data-testid="add-expense"]', { timeout: 10000 })
  if (await id('add-expense').isVisible().catch(() => false)) await id('back-to-groups').click()
  await id('tab-activity').waitFor({ timeout: 10000 }); await p.waitForTimeout(400)
  await p.goBack(); await p.waitForTimeout(600)
  check('after a reload, a single Back from Groups leaves the site', here() === 'about:blank', here())

  // ── two quick Backs from Settle up stay on the site ──
  await fresh(); await openGroup(); await id('settle-up').click(); await id('settle-card').waitFor(); await p.waitForTimeout(300)
  await p.evaluate(() => { history.back(); history.back() }); await p.waitForTimeout(900)
  check('two quick Backs from Settle up land on Groups, not off the site', onSite() && await id('tab-activity').isVisible(), here())

  // ── See all → Back returns to Activity ──
  await fresh(); await id('tab-activity').click(); await p.waitForSelector('[data-testid^="activity-seeall-"]', { timeout: 10000 }); await p.waitForTimeout(300)
  await p.locator('[data-testid^="activity-seeall-"]').first().click(); await p.waitForTimeout(500)
  check('See all narrows the feed to the group (the section buttons are gone)', (await p.locator('[data-testid^="activity-seeall-"]').count()) === 0 && await p.locator(feedRow).first().isVisible())
  await p.goBack(); await p.waitForTimeout(500)
  check('Back from See all returns to the Activity sections', onSite() && (await p.locator('[data-testid^="activity-seeall-"]').count()) > 0, here())
  await p.goBack(); await p.waitForTimeout(500)
  check('the next Back goes to Groups', onSite() && await id(`group-${gid}`).isVisible(), here())

  // ── sections reply that is junk, empty, 404 or HTML → the flat feed ──
  const replies = {
    'HTML 200': { status: 200, contentType: 'text/html', body: '<!doctype html><html><body>Divvy</body></html>' },
    '404': { status: 404, contentType: 'application/json', body: '{"error":"not found"}' },
    'empty list': { status: 200, contentType: 'application/json', body: '{"sections":[]}' },
    'junk entries': { status: 200, contentType: 'application/json', body: '{"sections":[null,{},{"group":{"id":"x"},"total":"many","items":[1,null]}]}' },
    'not an array': { status: 200, contentType: 'application/json', body: '{"sections":"nope"}' },
  }
  for (const [name, reply] of Object.entries(replies)) {
    await p.route('**/api/feed/sections*', (route) => route.fulfill(reply))
    await fresh(); await id('tab-activity').click(); await p.waitForSelector(feedRow, { timeout: 10000 }).catch(() => {}); await p.waitForTimeout(400)
    check(`sections reply "${name}" falls back to the flat feed`, (await p.locator(feedRow).count()) >= 3 && (await p.locator('[data-testid^="activity-seeall-"]').count()) === 0, `${await p.locator(feedRow).count()} rows`)
    await p.unroute('**/api/feed/sections*')
  }

  // ── contrast ──
  await fresh()
  const colorOf = (text) => p.evaluate((t) => { const e = [...document.querySelectorAll('div,span')].find((n) => n.children.length === 0 && n.textContent && n.textContent.includes(t)); return e ? getComputedStyle(e).color : null }, text)
  check('Groups hero eyebrow is solid white', await colorOf('Overall, across') === 'rgb(255, 255, 255)', String(await colorOf('Overall, across')))
  await openGroup()
  check('group hero eyebrow is solid white', await colorOf('Your balance') === 'rgb(255, 255, 255)', String(await colorOf('Your balance')))
  check('"Group spend" line is solid white', await colorOf('Group spend') === 'rgb(255, 255, 255)', String(await colorOf('Group spend')))
  const amber = await p.evaluate(() => [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).color === 'rgb(143, 82, 6)').length)
  check('amber avatar initials use #8f5206', amber > 0, String(amber))

  // ── Adjust: the error fits on one line ──
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350)
  await type('expense-amount', '120'); await id('method-adjust').click(); await p.waitForTimeout(200)
  const field = p.locator('[data-testid^="adjust-"]:not([data-testid^="adjust-sign"])').last()
  await field.click(); await field.press('Control+A'); await field.pressSequentially('-150', { delay: 15 }); await p.waitForTimeout(700)
  const lines = await p.evaluate(() => { const bar = document.querySelector('[data-testid="validation-bar"]'); return [...bar.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim()).map((e) => e.getClientRects().length && Math.round(e.getBoundingClientRect().height)) })
  const text = (await id('validation-bar').innerText()).replace(/\n/g, ' | ')
  const barBox = await id('validation-bar').boundingBox()
  check('Adjust error fits on one line each side', lines.length >= 1 && lines.every((h) => h > 0 && h < 24) && barBox.height < 60, `${text} ${JSON.stringify(lines)} ${barBox.height}`)
  if (shots) await p.screenshot({ path: `${shots}/adjust-error.png` })
  await p.keyboard.press('Escape'); await p.waitForTimeout(250); if (await id('discard-yes').isVisible().catch(() => false)) await id('discard-yes').click()
  await p.waitForTimeout(250)

  // ── currency sheet and the rate-error state ──
  await fetch(`${fake}/__down?on=1`)
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350)
  await type('expense-amount', '100')
  check('the amount row has a currency pill', /USD/.test(await id('currency-chip').innerText()))
  await id('currency-chip').click(); await id('currency-sheet').waitFor(); await p.waitForTimeout(500)
  const sheet = await id('currency-sheet').innerText()
  check('currency sheet has the Group currency and All currencies sections and a Done button', /Group currency/i.test(sheet) && /All currencies/i.test(sheet) && /Done/.test(sheet), sheet.slice(0, 120))
  if (shots) await p.screenshot({ path: `${shots}/currency-sheet.png` })
  await id('currency-search').fill('pound').catch(() => {}); await p.waitForTimeout(200)
  check('search lists matches', (await id('currency-GBP').count()) === 1)
  await id('currency-GBP').click(); await p.waitForTimeout(1500)
  check('the rate-error message shows', /rate/i.test(await id('fx-error').innerText()))
  const bad = await p.evaluate(() => { const e = document.querySelector('[data-testid="fx-error"]'); let n = e; while (n && n !== document.body) { const c = getComputedStyle(n); if (c.borderTopWidth !== '0px' && c.backgroundColor !== 'rgba(0, 0, 0, 0)') return { bg: c.backgroundColor, border: c.borderTopColor }; n = n.parentElement } return null })
  check('the rate-error box is red-tinted', !!bad && /^rgba\(255, 138, 148/.test(bad.bg), JSON.stringify(bad))
  const dashes = await p.evaluate(() => [...document.querySelectorAll('[data-testid="add-sheet"] *')].filter((e) => e.children.length === 0 && e.textContent.trim() === '—').length)
  check('split rows show a dash instead of amounts', dashes >= 2, String(dashes))
  const bar = (await id('validation-bar').innerText()).replace(/\n/g, ' | ')
  check('the validation bar says a rate is needed', /rate/i.test(bar), bar)
  if (shots) await p.screenshot({ path: `${shots}/rate-error.png` })
  await fetch(`${fake}/__down?on=0`)
  check('no page errors', errors.length === 0, errors.join('|'))
  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0)
})().catch((e) => { console.log('CRASH', e.message); process.exit(1) })
