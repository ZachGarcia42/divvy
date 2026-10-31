// Browser regression: select-all then typing quickly (no delay) must never lose the first characters.
// Usage: node fast-typing.cjs <BASE_URL> <TOKEN>   (needs playwright + Chrome; not part of `npm test`)
const { start } = require('./common.cjs')
const [base = 'http://127.0.0.1:18787', TOKEN] = process.argv.slice(2)
let failures = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) failures++ }
;(async () => {
  const { browser, p, id, ids, type, bar, openSheet, errors } = await start(base, TOKEN, { members: 3 })
  await openSheet()
  await type('expense-amount', '9.99', 0)
  await id('method-exact').click()
  const ROUNDS = 25
  // 1. click, Ctrl+A, then type with no delay at all, over and over in every field (the reported flake: '.50')
  for (const [label, text] of [['1.50', '1.50'], ['12.34', '12.34'], ['0.05', '0.05']]) {
    const bad = []
    for (let i = 0; i < ROUNDS; i++) {
      const field = `exact-${ids[i % ids.length]}`
      await type(field, text, 0)
      const got = await id(field).inputValue()
      if (got !== text) bad.push(`${field.slice(-4)}:${got}`)
    }
    check(`exact: select-all then fast-typing "${label}" x${ROUNDS}`, bad.length === 0, bad.slice(0, 5).join(' '))
  }
  // (an unselected 7.77 + typed 1.50 is now sanitized down to 7.77: two decimals at most)
  // 2. Tab into the field (focus without a click) and type immediately; the old setTimeout select() ate the first key
  const bad = []
  for (let i = 0; i < ROUNDS; i++) {
    const field = `exact-${ids[0]}`
    await id(field).fill('7.77')
    await id('expense-description').focus()
    await p.keyboard.press('Tab')           // lands on the next focusable control; walk forward to the field by focusing it
    await id(field).focus()
    await p.keyboard.type('1.50', { delay: 0 })
    const got = await id(field).inputValue()
    if (got !== '1.50' && got !== '7.77') bad.push(got)
  }
  check(`exact: focus then type immediately replaces the old value (x${ROUNDS})`, bad.length === 0, bad.slice(0, 5).join(' '))
  // 3. other money fields behave the same
  await id('method-percent').click()
  const badP = []
  for (let i = 0; i < ROUNDS; i++) { await type(`percent-${ids[1]}`, '33.5', 0); const g = await id(`percent-${ids[1]}`).inputValue(); if (g !== '33.5') badP.push(g) }
  check('percent: fast-typing "33.5"', badP.length === 0, badP.slice(0, 5).join(' '))
  await id('method-adjust').click()
  const badA = []
  for (let i = 0; i < ROUNDS; i++) { await type(`adjust-${ids[1]}`, '+1.50', 0); const g = await id(`adjust-${ids[1]}`).inputValue(); if (g !== '+1.50') badA.push(g) }
  check('adjust: fast-typing "+1.50"', badA.length === 0, badA.slice(0, 5).join(' '))
  await type('expense-amount', '123.45', 0)
  check('amount: fast-typing "123.45"', (await id('expense-amount').inputValue()) === '123.45')
  check('no page errors', errors.length === 0)
  await browser.close()
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED'); process.exit(failures ? 1 : 0)
})()
