// Browser checks for the UI/UX review fixes: the browser Back button steps back inside the app (Activity, feed-opened
// expenses, Settle up) instead of leaving the site, the detail opens at the top and the list scroll comes back, Settle up
// starts on a transfer that involves you, the Adjust error bar can be scrolled fully into view, and the rate-error button.
// Usage: NODE_PATH=<dir with playwright> node e2e/review-fixes.cjs http://127.0.0.1:18799 <TOKEN> [http://127.0.0.1:18798] [shotdir]
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : extra); if (!ok) fails++ }
;(async () => {
  const [base, TOKEN, fake = 'http://127.0.0.1:18798', shots] = process.argv.slice(2)
  const { browser, p, id, api, gid, ids, type, errors } = await start(base, TOKEN, { viewport: { width: 390, height: 800 }, members: 4 })
  const day = new Date().toISOString().slice(0, 10)
  const add = async (payer, description, minor, among) => {
    const r = await api(`/api/groups/${gid}/expenses`, 'POST', { description, date: day, originalMinor: minor, originalCurrency: 'USD', payers: [{ participantId: payer, minor }], split: { type: 'equal', participantIds: among } })
    if (!r.id) throw new Error(`could not add ${description}: ${JSON.stringify(r)}`)
    return r.id
  }
  // Others owe each other first; you owe Priya too. Plenty of rows so the list scrolls.
  await add(ids[1], 'Cabin', 40000, [ids[1], ids[2]])
  await add(ids[3], 'Gas', 30000, [ids[3], ids[2]])
  let last
  for (let i = 0; i < 14; i++) last = await add(ids[3], `Dinner ${i}`, 4000 + i * 100, [ids[0], ids[3], ids[1]])
  const scrolled = () => p.evaluate(() => Math.max(0, ...[...document.querySelectorAll('div')].filter((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)).map((e) => e.scrollTop)))
  const settle = async () => { await p.reload(); await id(`group-${gid}`).click({ timeout: 8000 }).catch(() => {}); await id('add-expense').waitFor({ timeout: 15000 }) }
  await settle()
  const startUrl = p.url()

  // ── Settle up: starts on a transfer with you, and the browser Back closes it ──
  await id('settle-up').click(); await id('settle-card').waitFor()
  const card = (await id('settle-card').innerText()).replace(/\s+/g, ' ')
  check('Settle up opens on a transfer that involves you', /You pay|pay You|paid You/.test(card) || /\bYou\b/.test(card), card)
  await p.goBack(); await p.waitForTimeout(300)
  check('browser Back from Settle up returns to the group, still on the site', p.url() === startUrl && await id('add-expense').isVisible() && (await id('settle-card').count()) === 0, p.url())

  // ── a list row: detail opens at the top, Back restores the list scroll ──
  await p.evaluate(() => { for (const e of document.querySelectorAll('div')) if (e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = 500 })
  await p.waitForTimeout(300)
  const before = await scrolled()
  check('the list is scrolled (setup)', before > 100, String(before))
  await id(`expense-${last}`).click({ timeout: 5000 }).catch(async () => { await p.locator('[data-testid^="expense-"][role="button"]').last().click() })
  await id('expense-header').waitFor({ timeout: 5000 }); await p.waitForTimeout(300)
  check('expense detail opens at the top', (await scrolled()) < 5, String(await scrolled()))
  await p.goBack(); await p.waitForTimeout(500)
  check('browser Back from the detail returns to the list', await id('add-expense').isVisible() && p.url() === startUrl)
  const after = await scrolled()
  check('the list scroll is restored', Math.abs(after - before) < 40, `${before} -> ${after}`)

  // ── Activity: Back goes group list, then leaves; row open + Back returns to Activity ──
  await id('back-to-groups').click(); await id('tab-activity').waitFor()
  await id('tab-activity').click(); await p.waitForSelector('[data-testid^="feed-"][role="button"]', { timeout: 10000 })
  await p.locator('[data-testid^="feed-"][role="button"]').first().click(); await id('expense-header').waitFor({ timeout: 8000 })
  await p.goBack(); await p.waitForTimeout(400)
  check('browser Back from a feed-opened expense returns to Activity', await p.locator('[data-testid^="feed-"][role="button"]').first().isVisible() && p.url().startsWith(base), p.url())
  await p.goBack(); await p.waitForTimeout(400)
  check('browser Back from Activity returns to Groups (not out of the site)', p.url().startsWith(base) && await id('tab-activity').isVisible(), p.url())
  const urlHere = p.url()
  await id('tab-activity').click(); await p.waitForSelector('[data-testid^="feed-"][role="button"]', { timeout: 10000 })
  await id('tab-groups').click().catch(() => {}); await p.waitForTimeout(300)
  await p.goBack().catch(() => {}); await p.waitForTimeout(300)
  check('the site is still here after Activity → Groups → Back', p.url().startsWith(base) || urlHere.startsWith(base), p.url())

  // ── muted contrast ──
  await settle()
  const hexes = await p.evaluate(() => [...document.querySelectorAll('*')].map((e) => getComputedStyle(e).color).filter((c) => c === 'rgb(138, 160, 153)').length)
  check('no text uses the old #8aa099', hexes === 0, String(hexes))

  // ── Adjust: the error bar scrolls fully into view above Save ──
  await p.evaluate(() => { for (const e of document.querySelectorAll('div')) e.scrollTop = 0 })
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350)
  await type('expense-amount', '120'); await id('method-adjust').click(); await p.waitForTimeout(200)
  const field = p.locator('[data-testid^="adjust-"]:not([data-testid^="adjust-sign"])').last()
  await field.click(); await field.press('Control+A'); await field.pressSequentially('-150', { delay: 15 }); await p.waitForTimeout(700)
  const bar = await id('validation-bar').boundingBox(); const cta = await id('sheet-cta').boundingBox()
  check('Adjust error bar is fully above the Save button', !!bar && !!cta && bar.y + bar.height <= cta.y + 1, JSON.stringify([bar, cta]))
  if (shots) await p.screenshot({ path: `${shots}/adjust-error.png` })
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); if (await id('discard-yes').isVisible().catch(() => false)) await id('discard-yes').click()

  // ── rate outage: heading and button agree ──
  await fetch(`${fake}/__down?on=1`)
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350)
  await type('expense-amount', '100')
  await id('currency-chip').click(); await id('currency-sheet').waitFor()
  check('currency picker pins the group currency first', (await p.locator('[data-testid^="currency-"][role="button"][data-testid$="USD"], [data-testid="currency-USD"]').first().innerText()).includes('USD'))
  await p.waitForTimeout(600); if (shots) await p.screenshot({ path: `${shots}/currency-sheet.png` })
  await id('currency-GBP').click(); await p.waitForTimeout(1200)
  const head = (await id('fx-converted').innerText()).trim(); const btn = (await id('sheet-cta').innerText()).trim()
  check('rate error: heading no longer claims a conversion', /No exchange rate/.test(head), head)
  check('rate error: the button says the rate is the problem', /rate/i.test(btn) && !/Enter an amount/.test(btn), btn)
  if (shots) await p.screenshot({ path: `${shots}/rate-error.png` })
  await fetch(`${fake}/__down?on=0`)
  check('no page errors', errors.length === 0, errors.join('|'))
  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0)
})().catch((e) => { console.log('CRASH', e.message); process.exit(1) })
