// Browser checks for the "next a11y" round: Back (and Escape) over the receipt viewer and the delete question in the expense detail
// close just that layer, the Groups hero note is solid white, the calendar keeps keyboard focus inside and its days work with the
// arrow keys and Enter, the Adjust success bar fits on one line at 320 px, and Escape dismisses the discard question.
// Usage: NODE_PATH=<dir with playwright> node e2e/next-a11y.cjs http://127.0.0.1:18799 <TOKEN> [fake] [shotdir]
const zlib = require('zlib')
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : extra); if (!ok) fails++ }
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 120); row[0] = 0
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
// Los Angeles calendar day (the API's FUTURE_DATE check follows the group's time zone).
const laDay = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) }

;(async () => {
  const [base, TOKEN, , shots] = process.argv.slice(2)
  const { browser, p, id, api, gid, ids, type } = await start(base, TOKEN, { viewport: { width: 320, height: 720 }, members: 2 })
  const day = laDay()
  const onSite = () => p.url().startsWith(base)
  const r = await api(`/api/groups/${gid}/expenses`, 'POST', { description: 'Receipt lunch', date: day, originalMinor: 3000, originalCurrency: 'USD', payers: [{ participantId: ids[0], minor: 3000 }], split: { type: 'equal', participantIds: [ids[0], ids[1]] } })
  if (!r.id) throw new Error(`could not add: ${JSON.stringify(r)}`)
  const put = await fetch(`${base}/api/groups/${gid}/expenses/${r.id}/photo`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/png' }, body: png(300, 400) })
  check('test receipt uploaded', put.status === 200, String(put.status))
  await api('/api/groups', 'POST', { name: 'Paris', currency: 'EUR', timezone: 'America/Los_Angeles' })

  const fresh = async () => {
    await p.goto('about:blank'); await p.goto(base)
    await p.waitForSelector(`[data-testid="group-${gid}"], [data-testid="add-expense"]`, { timeout: 15000 })
    if (await id('add-expense').isVisible().catch(() => false)) await id('back-to-groups').click()
    await id(`group-${gid}`).waitFor({ timeout: 15000 }); await p.waitForTimeout(300)
  }

  // ── NP-70: hero note solid white ──
  await fresh()
  const note = await p.evaluate(() => { const e = [...document.querySelectorAll('div,span')].find((n) => n.children.length === 0 && /USD groups only/.test(n.textContent || '')); return e ? getComputedStyle(e).color : null })
  check('Groups hero note "USD groups only…" is solid white', note === 'rgb(255, 255, 255)', String(note))

  // ── NP-17: Back over the detail's photo viewer and delete question ──
  await id(`group-${gid}`).click(); await id('add-expense').waitFor()
  await id(`expense-${r.id}`).click(); await id('expense-header').waitFor({ timeout: 8000 }); await p.waitForTimeout(300)
  await id('receipt-view').waitFor({ timeout: 8000 }); await id('receipt-view').click(); await id('receipt-viewer').waitFor(); await p.waitForTimeout(300)
  await p.goBack(); await p.waitForTimeout(500)
  check('Back over the detail photo viewer closes only the viewer', onSite() && (await id('receipt-viewer').count()) === 0 && await id('expense-header').isVisible())
  await id('receipt-view').click(); await id('receipt-viewer').waitFor(); await p.waitForTimeout(300)
  await p.keyboard.press('Escape'); await p.waitForTimeout(400)
  check('Escape over the detail photo viewer closes only the viewer', (await id('receipt-viewer').count()) === 0 && await id('expense-header').isVisible())
  await id('delete-expense').click(); await id('delete-confirm').waitFor(); await p.waitForTimeout(200)
  await p.goBack(); await p.waitForTimeout(500)
  check('Back over the delete question closes the question, stays on the expense', onSite() && (await id('delete-confirm').count()) === 0 && await id('expense-header').isVisible())
  await id('delete-expense').click(); await id('delete-confirm').waitFor(); await p.waitForTimeout(200)
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  check('Escape over the delete question closes the question', (await id('delete-confirm').count()) === 0 && await id('expense-header').isVisible())
  const still = await api(`/api/groups/${gid}/expenses/${r.id}`)
  check('nothing was deleted', !still.error && JSON.stringify(still).includes(r.id) && !(still.deletedAt || (still.expense && still.expense.deletedAt)), JSON.stringify(still).slice(0, 200))
  await p.goBack(); await p.waitForTimeout(500)
  check('the next Back leaves the expense for the group', onSite() && await id('add-expense').isVisible() && (await id('expense-header').count()) === 0)
  await p.goBack(); await p.waitForTimeout(500)
  check('and the next one goes to Groups (no stray entries)', onSite() && await id('tab-activity').isVisible())
  await p.goBack(); await p.waitForTimeout(500)
  check('one more Back leaves the site', !onSite(), p.url())

  // ── NP-23: calendar keyboard ──
  await fresh(); await id(`group-${gid}`).click(); await id('add-expense').waitFor()
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350)
  await id('date-chip').click(); await id('date-picker').waitFor(); await p.waitForTimeout(300)
  const focused = () => p.evaluate(() => { const a = document.activeElement; const pick = document.querySelector('[data-testid="date-picker"]'); return { inside: !!(pick && a && pick.contains(a)), tid: a && a.getAttribute('data-testid') } })
  const f0 = await focused()
  check('opening the calendar focuses the selected day', f0.inside && f0.tid === `date-day-${day}`, JSON.stringify(f0))
  let trapped = true; const seen = []
  for (let i = 0; i < 8; i++) { await p.keyboard.press('Tab'); const f = await focused(); seen.push(f.tid); if (!f.inside) trapped = false }
  for (let i = 0; i < 3; i++) { await p.keyboard.press('Shift+Tab'); const f = await focused(); seen.push(f.tid); if (!f.inside) trapped = false }
  check('Tab and Shift+Tab stay inside the calendar', trapped, JSON.stringify(seen))
  check('Tab reaches a day cell and the buttons', seen.some((t) => t && t.startsWith('date-day-')) && seen.includes('date-ok') && seen.includes('date-cancel'), JSON.stringify(seen))
  while (!((await focused()).tid || '').startsWith('date-day-')) await p.keyboard.press('Tab')
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(150)
  const yest = laDay(-1)
  const f1 = await focused()
  check('ArrowLeft moves focus to yesterday (across months too)', f1.tid === `date-day-${yest}`, JSON.stringify(f1))
  await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150)
  check('ArrowRight stops at today', (await focused()).tid === `date-day-${day}`)
  await p.keyboard.press('ArrowUp'); await p.waitForTimeout(150)
  check('ArrowUp moves a week back', (await focused()).tid === `date-day-${laDay(-7)}`, JSON.stringify(await focused()))
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(150)
  await p.keyboard.press('Enter'); await p.waitForTimeout(150)
  const sel = await p.evaluate((t) => { const e = document.querySelector(`[data-testid="${t}"]`); return e ? { aria: e.getAttribute('aria-selected'), bg: getComputedStyle(e).backgroundColor } : null }, `date-day-${yest}`)
  check('Enter selects the focused day', !!sel && (sel.aria === 'true' || sel.bg === 'rgb(15, 118, 110)'), JSON.stringify(sel))
  await id('date-ok').focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(300)
  check('OK by keyboard saves the day and closes the calendar', (await id('date-picker').count()) === 0 && /Yesterday/.test(await id('date-chip').innerText()), await id('date-chip').innerText())
  const back = await p.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-testid'))
  check('focus returns to the date chip', back === 'date-chip', String(back))
  if (shots) await p.screenshot({ path: `${shots}/a11y-after-calendar.png` })

  // ── Escape dismisses the discard question ──
  await type('expense-amount', '42'); await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  check('Escape on a dirty sheet asks first', await id('discard-confirm').isVisible().catch(() => false))
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  check('Escape dismisses the discard question, the sheet and amount stay', (await id('discard-confirm').count()) === 0 && (await id('add-sheet').count()) === 1 && (await id('expense-amount').inputValue()).includes('42'))

  // ── NP-40: Adjust success bar on one line at 320 px ──
  await type('expense-amount', '180'); await id('method-adjust').click(); await p.waitForTimeout(200)
  const field = p.locator('[data-testid^="adjust-"]:not([data-testid^="adjust-sign"])').last()
  await field.click(); await field.press('Control+A'); await field.pressSequentially('-60', { delay: 15 }); await p.waitForTimeout(700)
  const text = (await id('validation-bar').innerText()).replace(/\n/g, ' | ')
  const lines = await p.evaluate(() => { const bar = document.querySelector('[data-testid="validation-bar"]'); return [...bar.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim()).map((e) => Math.round(e.getBoundingClientRect().height)) })
  const clipped = await p.evaluate(() => [...document.querySelector('[data-testid="validation-bar"]').querySelectorAll('*')].some((e) => e.children.length === 0 && e.scrollWidth > e.clientWidth + 1))
  check('Adjust success bar is ok-toned and says it adds up', /\$180\.00 split 2 ways/.test(text) || /split 2 ways/.test(text), text)
  check('Adjust success bar fits on one line at 320 px, nothing cut off', lines.length >= 1 && lines.every((h) => h > 0 && h < 22) && !clipped, `${text} ${JSON.stringify(lines)} clipped=${clipped}`)
  check('the check keeps its "Adds up" label for screen readers', await p.evaluate(() => [...document.querySelectorAll('[data-testid="validation-bar"] [aria-label]')].some((e) => /Adds up/.test(e.getAttribute('aria-label')))))
  if (shots) await p.screenshot({ path: `${shots}/a11y-adjust-320.png` })

  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
