// Browser checks for multiple currencies: pick a currency in the Add sheet, see the converted amount and rate for the
// day (weekend -> latest previous rate), save, read the detail, edit (currency and amount), the outage path with a
// manual rate, the $100,000 cap on the converted amount, and creating a group in another currency.
// Needs the stack from serve-fx.mts (it fakes Frankfurter and exposes /__down on the fake's port).
// Usage: NODE_PATH=<dir with playwright> node e2e/multi-currency.cjs http://127.0.0.1:18799 <TOKEN> [http://127.0.0.1:18798]
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : extra); if (!ok) fails++ }
;(async () => {
  const [base, TOKEN, fake = 'http://127.0.0.1:18798'] = process.argv.slice(2)
  const { browser, p, id, api, gid, bar, type, openSheet, closeSheet, errors } = await start(base, TOKEN)
  const text = async (t) => (await id(t).innerText()).replace(/\s+/g, ' ').trim()
  const pickCurrency = async (code) => {
    await id('currency-chip').click(); await id('currency-search').waitFor()
    await type('currency-search', code.toLowerCase()); await id(`currency-${code}`).click(); await p.waitForTimeout(250)
  }
  const saveAndWait = async () => { await id('sheet-cta').click(); await id('add-sheet').waitFor({ state: 'detached', timeout: 10000 }); await p.waitForTimeout(500) }

  // 1. Add €100 on a day with no fixing of its own (today, or a weekend): the latest previous rate is used and says so
  await openSheet()
  check('the amount starts in the group currency', /USD|\$/.test(await text('currency-chip')), await text('currency-chip'))
  await pickCurrency('EUR')
  await type('expense-amount', '100'); await type('expense-description', 'Dinner in Lisbon')
  await id('fx-converted').waitFor({ timeout: 8000 })
  check('shows the converted amount', /\$107\.65/.test(await text('fx-converted')), await text('fx-converted'))
  check('shows the rate and its date', /1 EUR = 1\.0765 USD/.test(await text('fx-rate')) && /Oct/.test(await text('fx-rate')), await text('fx-rate'))
  check('the equal split runs on the converted total', /\$26\.91/.test(await bar()), await bar())
  await saveAndWait()
  await p.getByText(/Dinner in Lisbon/).first().waitFor()
  check('the list row carries the original amount', /€100\.00/.test(await p.getByText(/Dinner in Lisbon/).first().locator('xpath=ancestor::*[@data-testid][1]').innerText().catch(() => '')) || (await p.getByText('€100.00').count()) > 0)
  const exp = (await api(`/api/groups/${gid}`)).expenses.find((e) => e.description === 'Dinner in Lisbon')
  check('API stored original, converted, rate', exp.originalMinor === 10000 && exp.originalCurrency === 'EUR' && exp.settlementMinor === 10765 && exp.rate === '1.0765', JSON.stringify(exp))

  // 2. Detail shows original, converted and rate
  await id(`expense-${exp.id}`).click(); await id('expense-conversion').waitFor()
  check('detail total is in the group currency', /\$107\.65/.test(await text('expense-total')), await text('expense-total'))
  check('detail shows original amount', /€100\.00/.test(await text('expense-original')), await text('expense-original'))
  check('detail shows the rate', /1 EUR = 1\.0765 USD/.test(await text('expense-rate')), await text('expense-rate'))
  check('detail names the source', /ECB/i.test(await text('expense-rate-source')), await text('expense-rate-source'))

  // 3. Edit: the sheet opens in EUR with the stored rate; amount edit keeps the rate; the rate source is not asked again
  const before = (await (await fetch(`${fake}/__hits`)).json()).hits
  await id('edit-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(400)
  check('edit opens in the original currency and amount', /EUR|€/.test(await text('currency-chip')) && (await id('expense-amount').inputValue()) === '100.00', `${await text('currency-chip')} ${await id('expense-amount').inputValue()}`)
  await type('expense-amount', '200')
  check('edit converts at the stored rate', /\$215\.30/.test(await text('fx-converted')), await text('fx-converted'))
  await saveAndWait()
  const after = (await (await fetch(`${fake}/__hits`)).json()).hits
  check('same date and currency do not refetch', after === before, `${before} -> ${after}`)
  await id('expense-total').waitFor()
  check('detail total follows the edit', /\$215\.30/.test(await text('expense-total')), await text('expense-total'))
  check('history records the change', /amount/.test(await text('history')), await text('history'))

  // 4. Edit the currency: JPY refetches; 0-decimal validation; converted amount
  await id('edit-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(400)
  await pickCurrency('JPY')
  await id('fx-rate').waitFor({ timeout: 8000 })
  check('changing the currency refetches the rate', /1 JPY = 0\.0066 USD/.test(await text('fx-rate')), await text('fx-rate'))
  await type('expense-amount', '15000')
  check('JPY converts with 0 decimals', /\$99\.00/.test(await text('fx-converted')), await text('fx-converted'))
  await saveAndWait()
  await id('expense-original').waitFor()
  check('detail shows ¥15,000', /¥15,000/.test(await text('expense-original')), await text('expense-original'))
  const jp = (await api(`/api/groups/${gid}/expenses/${exp.id}`)).expense
  check('API: JPY minor units are whole yen', jp.originalMinor === 15000 && jp.settlementMinor === 9900 && jp.rate === '0.0066', JSON.stringify(jp))
  check('history records the currency', /currency/.test(await text('history')), await text('history'))
  await id('back-to-group').click()

  // 5. Cap applies to the converted amount
  await openSheet(); await pickCurrency('JPY'); await type('expense-amount', '20000000'); await type('expense-description', 'Too big')
  await id('fx-converted').waitFor({ timeout: 8000 }).catch(() => {})
  check('cap message names the converted limit', /100,000/.test(await bar()) || /100,000/.test(await p.locator('body').innerText()), await bar())
  check('save is disabled over the cap', await id('sheet-cta').isDisabled().catch(async () => (await id('sheet-cta').getAttribute('aria-disabled')) === 'true'))
  await closeSheet()

  // 6. Source down: a clear error, then a manual rate
  await fetch(`${fake}/__down?on=1`)
  await openSheet(); await pickCurrency('GBP'); await type('expense-amount', '10'); await type('expense-description', 'Taxi')
  await id('fx-error').waitFor({ timeout: 10000 })
  check('outage shows a clear error', /rate/i.test(await text('fx-error')), await text('fx-error'))
  check('save is disabled without a rate', await id('sheet-cta').isDisabled().catch(async () => (await id('sheet-cta').getAttribute('aria-disabled')) === 'true'))
  await id('fx-rate-edit').click(); await type('fx-rate-input', '1.25')
  check('manual rate converts', /\$12\.50/.test(await text('fx-converted')), await text('fx-converted'))
  await saveAndWait()
  const taxi = (await api(`/api/groups/${gid}`)).expenses.find((e) => e.description === 'Taxi')
  check('API: manual rate stored and flagged', taxi && taxi.settlementMinor === 1250 && taxi.rate === '1.25' && taxi.rateSource === 'manual', JSON.stringify(taxi))
  await id(`expense-${taxi.id}`).click(); await id('expense-rate-source').waitFor()
  check('detail says the rate was entered by hand', /hand|manual/i.test(await text('expense-rate-source')), await text('expense-rate-source'))
  await id('back-to-group').click()
  await fetch(`${fake}/__down?on=0`)

  // 7. Balances stay in the group currency and never move afterwards
  const g1 = await api(`/api/groups/${gid}`)
  await fetch(`${fake}/__down?on=1`)
  const g2 = await api(`/api/groups/${gid}`)
  check('balances are stable and in the group currency', g1.currency === 'USD' && JSON.stringify(g1.balances) === JSON.stringify(g2.balances), '')
  await fetch(`${fake}/__down?on=0`)

  // 8. Create a group in another currency
  await id('back-to-groups').click(); await id('create-group-card').click(); await id('create-group-sheet').waitFor()
  await id('group-currency').click(); await type('group-currency-search', 'eur'); await id('group-currency-EUR').click()
  await type('group-name', 'Lisbon'); await id('create-group-save').click()
  await id('add-expense').waitFor({ timeout: 10000 })
  const lis = (await api('/api/home')).groups.find((g) => g.name === 'Lisbon')
  check('new group has the chosen home currency', lis && lis.currency === 'EUR', JSON.stringify(lis))

  check('no page errors', errors.length === 0, errors.join('; '))
  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0)
})().catch((e) => { console.log('CRASH', e.message); process.exit(1) })
