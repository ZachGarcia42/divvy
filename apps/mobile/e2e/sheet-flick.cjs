// Browser checks for the web grab-pill flick on a big desktop viewport (1920x1113), with Playwright's page.mouse:
// a quick flick closes the create-group sheet whatever the number of move steps, even on a heavily CPU-throttled page (handlers run
// long after the browser stamps the pointer events); a slow drag, a pause before release and a short flick do not. The sheet is allowed to finish sliding in first.
// Usage: NODE_PATH=<dir with playwright> node e2e/sheet-flick.cjs http://127.0.0.1:18787 <TOKEN>
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) fails++ }
;(async () => {
  const [base, TOKEN] = process.argv.slice(2)
  const { browser, p, id, errors } = await start(base, TOKEN, { viewport: { width: 1920, height: 1113 } })
  await id('back-to-groups').click(); await id('create-group-card').waitFor()
  const settled = async () => { let prev; for (;;) { const b = await id('create-group-sheet').boundingBox(); if (prev !== undefined && Math.abs(b.y - prev) < 0.5) return b; prev = b.y; await p.waitForTimeout(80) } }
  const open = async () => { await id('create-group-card').click(); await id('create-group-sheet').waitFor(); await p.waitForTimeout(450); return settled() }
  const dismiss = async () => { if ((await id('create-group-sheet').count()) === 1) { await p.keyboard.press('Escape'); await p.waitForTimeout(350) } }
  const drag = async (dy, steps, { pace = 0, hold = 0 } = {}) => {
    const b = await id('sheet-pill').boundingBox(); const x = b.x + b.width / 2, y = b.y + b.height / 2
    await p.mouse.move(x, y); await p.mouse.down()
    for (let i = 1; i <= steps; i++) { await p.mouse.move(x, y + (dy * i) / steps); if (pace) await p.waitForTimeout(pace) }
    if (hold) await p.waitForTimeout(hold)
    await p.mouse.up(); await p.waitForTimeout(500)
  }
  const cdp = await p.context().newCDPSession(p)
  const sb = await open(); const h = sb.height
  check('sheet is compact on the big viewport', h < 600 && sb.y > 400, `top=${Math.round(sb.y)} h=${Math.round(h)}`)
  await dismiss()
  for (const dy of [100, 130]) {
    for (const [steps, pace] of [[1, 0], [2, 0], [3, 0], [5, 0], [5, 10]]) {
      const b = await open()
      await drag(dy, steps, { pace })
      check(`page.mouse flick ${dy}px, ${steps} step(s)${pace ? `, ${pace}ms apart` : ''} dismisses (under a third of ${Math.round(b.height)}px)`, dy < b.height / 3 && (await id('create-group-sheet').count()) === 0)
      await dismiss()
    }
  }
  for (const [dy, steps] of [[100, 1], [130, 5]]) {
    const b = await open()
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 16 }) // a slow, busy machine: handlers run well after the browser stamps the events
    await drag(dy, steps)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    check(`flick ${dy}px, ${steps} step(s) still dismisses on a 16x slower CPU`, (await id('create-group-sheet').count()) === 0, `h=${Math.round(b.height)}`)
    await dismiss()
  }
  await open(); await drag(100, 5, { pace: 60 })
  check('a slow 100px drag (under a third) snaps back, no dismiss', (await id('create-group-sheet').count()) === 1)
  await dismiss()
  await open(); await drag(120, 4, { hold: 400 })
  check('a fast move then a pause before release does not dismiss', (await id('create-group-sheet').count()) === 1)
  await dismiss()
  await open(); await drag(50, 1)
  check('a 50px one-step flick does not dismiss', (await id('create-group-sheet').count()) === 1)
  await dismiss()
  await open(); await drag(Math.round(h / 3) + 40, 6, { pace: 50 })
  check('a slow drag past a third dismisses', (await id('create-group-sheet').count()) === 0)
  check('no page errors', errors.length === 0, errors.join('|'))
  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
})()
