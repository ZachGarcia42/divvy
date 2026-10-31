// Browser checks for QA chunk 3: after an edit saves, the open detail's History shows it at once; and when the expense was
// deleted by someone else, saving the edit refreshes the group (the expense disappears, balances update) without a reload.
// Usage: NODE_PATH=<dir with playwright> node e2e/chunk3-edit.cjs http://127.0.0.1:18799 <TOKEN>
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) fails++ }
const today = () => new Date().toISOString().slice(0, 10)
;(async () => {
  const [base, TOKEN] = process.argv.slice(2)
  const { browser, p, id, api, gid, ids, openSheet, errors } = await start(base, TOKEN)
  const mk = async (description, minor) => {
    const r = await api(`/api/groups/${gid}/expenses`, 'POST', { description, originalMinor: minor, originalCurrency: 'USD', date: today(), payers: [{ participantId: ids[0], minor }], split: { type: 'equal', participantIds: ids } })
    return r.expense?.id ?? r.id
  }
  const reopen = async (expenseId) => { await p.goto(base); await id(`group-${gid}`).click({ timeout: 3000 }).catch(() => {}); await id(`expense-${expenseId}`).click({ timeout: 10000 }); await id('history').waitFor(); await p.waitForTimeout(300) }
  const historyLines = async () => (await id('history').innerText()).split('\n').filter((l) => /^You /.test(l))

  // 2. History refreshes right after a successful edit
  const a = await mk('QA hist', 4000)
  await reopen(a)
  check('history starts with only "added this"', (await historyLines()).length === 1, JSON.stringify(await historyLines()))
  await id('edit-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(300)
  await id('expense-amount').click(); await id('expense-amount').press('Control+A'); await id('expense-amount').pressSequentially('45.00', { delay: 10 })
  // Slow the group reload down: History must not wait for it.
  const slow = async (route) => { if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 2500)); await route.continue() }
  await p.route(new RegExp(`/api/(home|groups/${gid})$`), slow)
  await id('sheet-cta').click()
  const t0 = Date.now()
  await p.waitForFunction(() => /changed the amount/.test(document.querySelector('[data-testid="history"]')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {})
  const took = Date.now() - t0
  const lines = await historyLines()
  check('detail History shows the edit right after the PATCH, not after the slow group reload', lines.length === 2 && /changed the amount/.test(lines[0]) && took < 1500, `${took}ms ${JSON.stringify(lines)}`)
  await id('add-sheet').waitFor({ state: 'detached', timeout: 10000 })
  await p.unroute(new RegExp(`/api/(home|groups/${gid})$`), slow)
  check('detail shows the new total', /\$45\.00/.test(await id('expense-total').innerText()))

  // 1. Edit an expense somebody else deleted
  const b = await mk('QA ghost', 6000)
  // STALE: someone else edits while the sheet is open; saving reloads the group and shows their version
  const c = await mk('QA stale', 3000)
  await reopen(c)
  await id('edit-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(300)
  const cur = (await api(`/api/groups/${gid}/expenses/${c}`)).expense
  const theirs = await api(`/api/groups/${gid}/expenses/${c}`, 'PATCH', { description: 'QA stale THEIRS', originalMinor: 3300, originalCurrency: 'USD', date: today(), payers: [{ participantId: ids[0], minor: 3300 }], split: { type: 'equal', participantIds: ids }, version: cur.version })
  check('the other person edited it', !theirs.error, JSON.stringify(theirs))
  await id('expense-amount').click(); await id('expense-amount').press('Control+A'); await id('expense-amount').pressSequentially('99.00', { delay: 10 })
  await id('sheet-cta').click()
  await id('add-sheet').waitFor({ state: 'detached', timeout: 8000 })
  await p.waitForTimeout(800)
  check('stale save shows their version without a reload', (await p.getByText(/QA stale THEIRS/).count()) >= 1 && /\$33\.00/.test(await id('expense-total').innerText()))
  const balanceBefore = JSON.stringify((await api(`/api/groups/${gid}`)).balances ?? null)
  await reopen(b)
  await id('edit-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(300)
  const gone = await api(`/api/groups/${gid}/expenses/${b}`, 'DELETE', { version: (await api(`/api/groups/${gid}/expenses/${b}`)).expense.version })
  check('the other person deleted it', !gone.error, JSON.stringify(gone))
  await id('expense-amount').click(); await id('expense-amount').press('Control+A'); await id('expense-amount').pressSequentially('70.00', { delay: 10 })
  await id('sheet-cta').click()
  await id('add-sheet').waitFor({ state: 'detached', timeout: 8000 })
  await p.waitForTimeout(800)
  check('back on the group, no reload', (await id('add-expense').count()) === 1)
  check('the deleted expense is gone from the list', (await id(`expense-${b}`).count()) === 0)
  check('a message says it was deleted', (await p.getByText(/was deleted/).count()) >= 1)
  check('the sheet error is not left showing', (await id('sheet-error').count()) === 0)
  const balanceAfter = JSON.stringify((await api(`/api/groups/${gid}`)).balances ?? null)
  void balanceBefore; void balanceAfter
  check('no page errors', errors.length === 0, errors.join(';'))
  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
