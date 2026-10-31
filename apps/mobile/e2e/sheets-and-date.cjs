// Browser checks for v2 feedback items 2-5: the Groups header has no "+" button, no template chips, the grab pill drags
// (resize / dismiss) without selecting text, and the add-expense date is a real picker with Today / Yesterday labels.
// Usage: NODE_PATH=<dir with playwright> node e2e/sheets-and-date.cjs http://127.0.0.1:18787 <TOKEN>
const { start } = require('./common.cjs')
const iso = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) fails++ }
;(async () => {
  const [base, TOKEN] = process.argv.slice(2)
  const { browser, p, id, api, gid, errors } = await start(base, TOKEN, { viewport: { width: 420, height: 900 } })
  const vh = 900
  // --- Groups home
  await id('back-to-groups').click(); await id('create-group-card').waitFor()
  check('no round + create button', (await id('create-group-plus').count()) === 0)
  check('Create a group card kept', await id('create-group-card').isVisible())
  check('no "Start from a template" text', (await p.getByText(/start from a template/i).count()) === 0)
  await id('create-group-card').click(); await id('create-group-sheet').waitFor(); await p.waitForTimeout(400)
  check('create sheet uses the New group header', (await p.getByText('New group', { exact: true }).count()) === 1 && (await id('create-group-cancel').count()) === 1)
  check('single full-width Create group button', (await id('create-group-save').innerText()).trim() === 'Create group')
  check('no free-text Currency field in the create sheet', (await id('group-currency').count()) === 0 && (await id('create-group-sheet').getByText('Currency', { exact: true }).count()) === 0)
  check('no template chips in sheet', (await p.locator('[data-testid^="template-"]').count()) === 0)
  check('no Trip/Home/Couple/Dinners chips', (await p.getByText(/^(🏔️|🏠|💑|🍜)\s+(Trip|Home|Couple|Dinners)$/).count()) === 0)
  const height = async () => (await id('create-group-sheet').boundingBox()).height
  const pill = async () => { const b = await id('sheet-pill').boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
  const dragPill = async (dy, steps = 8, pace = 0) => { const { x, y } = await pill(); await p.mouse.move(x, y); await p.mouse.down(); for (let i = 1; i <= steps; i++) { await p.mouse.move(x, y + (dy * i) / steps); if (pace) await p.waitForTimeout(pace) } await p.mouse.up(); await p.waitForTimeout(450) }
  const selected = () => p.evaluate(() => String(window.getSelection()))
  const h0 = await height()
  await dragPill(-200)
  const h1 = await height()
  check('drag pill up expands to the tall snap', h1 > h0 + 100 && Math.abs(h1 - vh * 0.92) < 6, `compact=${Math.round(h0)} tall=${Math.round(h1)}`)
  check('dragging the pill selects no text', (await selected()) === '', JSON.stringify(await selected()))
  await dragPill(200)
  const h2 = await height()
  check('drag pill down collapses to compact', Math.abs(h2 - h0) < 6, `h=${Math.round(h2)}`)
  await dragPill(20, 4)
  check('small drag snaps back (stays open)', (await id('create-group-sheet').count()) === 1 && Math.abs((await height()) - h0) < 6)
  await dragPill(40, 2)
  check('a quick 40px drag does not dismiss', (await id('create-group-sheet').count()) === 1 && Math.abs((await height()) - h0) < 6, `h0=${Math.round(h0)}`)
  await dragPill(Math.round(h0 / 3) - 15, 10, 40)   // a slow drag, so it is not a flick
  check('drag just under a third of the sheet height does not dismiss', (await id('create-group-sheet').count()) === 1)
  await dragPill(Math.round(h0 / 3) + 30, 10, 40)
  check('drag pill down past a third dismisses the sheet', (await id('create-group-sheet').count()) === 0)
  // A quick flick (100-130px, under a third of the sheet) closes it whatever the number of mouse-move steps.
  // react-native-web's own gesture vy is wrong for these (a one-step flick reads ~0 px/ms), so the sheet times the moves itself.
  for (const dy of [100, 130]) {
    for (const steps of [1, 2, 3, 5]) { // (10 steps are left out: Playwright spaces them ~15-25ms apart, so 100-150px is about 0.6-0.8 px/ms, right on the 0.7 line)
      await id('create-group-card').click(); await id('create-group-sheet').waitFor(); await p.waitForTimeout(400)
      const hf = await height()
      await dragPill(dy, steps)
      check(`flick ${dy}px in ${steps} step(s) dismisses (under a third of ${Math.round(hf)}px)`, dy < hf / 3 && (await id('create-group-sheet').count()) === 0)
      if ((await id('create-group-sheet').count()) === 1) { await p.keyboard.press('Escape'); await p.waitForTimeout(300) }
    }
  }
  // ...but pausing before letting go is a drag, not a flick, and a short flick (under 60px) never counts.
  await id('create-group-card').click(); await id('create-group-sheet').waitFor(); await p.waitForTimeout(400)
  { const { x, y } = await pill(); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x, y + 100, { steps: 4 }); await p.waitForTimeout(400); await p.mouse.up(); await p.waitForTimeout(450) }
  check('a fast move then a pause before release does not dismiss', (await id('create-group-sheet').count()) === 1)
  await dragPill(50, 1)
  check('a 50px one-step flick does not dismiss', (await id('create-group-sheet').count()) === 1)
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  await id('create-group-card').click(); await id('create-group-sheet').waitFor(); await p.waitForTimeout(400)
  await dragPill(-200)
  await dragPill(300)
  check('from tall, one long drag down collapses (does not dismiss)', (await id('create-group-sheet').count()) === 1)
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  check('Escape still closes the sheet', (await id('create-group-sheet').count()) === 0)
  // --- Date picker in Add expense
  await id(`group-${gid}`).click(); await id('add-expense').waitFor(); await p.waitForTimeout(200)
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(400)
  const chip = () => id('date-chip').innerText()
  check('default label is Today', /Today/.test(await chip()), await chip())
  const input = id('date-input')
  const hit = await p.evaluate(() => { const c = document.querySelector('[data-testid="date-chip"]').getBoundingClientRect(); const e = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2); return { tag: e.tagName, inChip: !!e.closest('[data-testid="date-chip"]') } })
  check('the date <input> does not overlay the chip label (click lands on the chip)', hit.tag !== 'INPUT' && hit.inChip, JSON.stringify(hit))
  check('chip shows the calendar icon', /📅/.test(await chip()), await chip())
  await id('date-chip').click(); await p.waitForTimeout(150);
  check('date control is a native date input', (await input.getAttribute('type')) === 'date' && (await input.inputValue()) === iso(0))
  check('cannot pick the future (max=today)', (await input.getAttribute('max')) === iso(0))
  await input.fill(iso(-1)); check('yesterday labelled Yesterday', /Yesterday/.test(await chip()), await chip())
  await input.fill(iso(-9)); const lab = await chip(); check('older date shows a weekday + month/day, not Today/Yesterday', !/Today|Yesterday/.test(lab) && /[A-Z][a-z]{2}/.test(lab), lab)
  await input.fill(iso(0)); check('back to Today', /Today/.test(await chip()))
  // dirty only when the date changed: Escape with only the date changed must ask to discard
  await input.fill(iso(-3)); await p.keyboard.press('Escape'); await p.waitForTimeout(250)
  check('changing only the date makes the sheet dirty (discard prompt)', await id('discard-yes').isVisible().catch(() => false))
  await id('discard-keep').click(); await p.waitForTimeout(200)
  // save with a picked date, check the stored date and the list heading
  await id('expense-amount').fill('12.00'); await id('expense-description').fill('Picked date lunch').catch(() => {})
  const before = (await api(`/api/groups/${gid}`)).expenses.length
  await id('sheet-save').click().catch(async () => { await p.getByText('Save', { exact: true }).last().click() })
  await p.waitForTimeout(900)
  const after = (await api(`/api/groups/${gid}`)).expenses
  const saved = after.find((e) => e.description === 'Picked date lunch')
  check('expense saved with the picked local date', !!saved && saved.date === iso(-3), JSON.stringify(saved && saved.date))
  // --- Edit history reads newest first: two edits on top of the "added" row
  if (saved) {
    let v = (await api(`/api/groups/${gid}/expenses/${saved.id}`)).expense.version
    for (const body of [{ description: 'Picked date lunch 2' }, { originalMinor: 1300 }]) {
      await api(`/api/groups/${gid}/expenses/${saved.id}`, 'PATCH', { version: v, ...body }); v++
    }
    const rest = (await api(`/api/groups/${gid}/expenses/${saved.id}`)).history
    check('API still sends history oldest first', rest.length === 3 && rest[0].kind === 'created', rest.map((h) => h.kind).join(','))
    await p.goto(base); await id(`group-${gid}`).click({ timeout: 3000 }).catch(() => {}); await id(`expense-${saved.id}`).click({ timeout: 10000 }); await id('history').waitFor(); await p.waitForTimeout(500)
    const lines = (await id('history').innerText()).split('\n').filter((l) => /^You /.test(l))
    check('history is newest first: amount edit, description edit, then added', lines.length === 3 && /changed the amount/.test(lines[0]) && /changed the description/.test(lines[1]) && /added this/.test(lines[2]), JSON.stringify(lines))
  }
  // --- Creating a group sends USD
  await p.goto(base); await id('back-to-groups').click({ timeout: 8000 }).catch(() => {}); await id('create-group-card').click(); await id('create-group-sheet').waitFor(); await p.waitForTimeout(400)
  await id('group-name').fill('Currency check')
  const posted = p.waitForRequest((r) => r.method() === 'POST' && /\/api\/groups$/.test(r.url()))
  await id('create-group-save').click()
  const sent = JSON.parse((await posted).postData() || '{}')
  check('Create group posts currency USD', sent.currency === 'USD' && sent.name === 'Currency check', JSON.stringify(sent))
  check('no page errors', errors.length === 0, errors.join(';'))
  await p.screenshot({ path: '/workspace/eng-scratch/shots/after-date.png' })
  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
