// Browser checks (vc10 feedback): the header icons (Ionicons glyphs) are drawn and their ink is centred in the round buttons;
// the main page's top gap is small; a flick closes the sheet in ONE slide (the panel never moves back up before it unmounts).
// Usage: NODE_PATH=<dir with playwright> node e2e/icons-and-flick.cjs http://127.0.0.1:18799 <TOKEN>
const fs = require('fs')
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) fails++ }
;(async () => {
  const [base, TOKEN] = process.argv.slice(2)
  const { browser, p, id, errors } = await start(base, TOKEN, { viewport: { width: 390, height: 844 } })
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500)
  // ink bounds of dark pixels inside a round button, from a screenshot decoded on a canvas
  const ink = async (testId, file) => {
    const png = await id(testId).screenshot({ path: file })
    return p.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const g = c.getContext('2d'); g.drawImage(img, 0, 0)
      const { data, width, height } = g.getImageData(0, 0, c.width, c.height)
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4; const lum = (data[i] + data[i + 1] + data[i + 2]) / 3
        const dx = x + 0.5 - width / 2, dy = y + 0.5 - height / 2
        if (lum < 140 && dx * dx + dy * dy < (width / 2 - 5) ** 2) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
      }
      return { n, cx: (x0 + x1 + 1) / 2 - width / 2, cy: (y0 + y1 + 1) / 2 - height / 2, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    }, png.toString('base64'))
  }
  fs.mkdirSync('/workspace/eng-scratch/shots', { recursive: true })
  // the group header (start() leaves the app on the group)
  for (const [btn, icon] of [['back-to-groups', 'icon-chevron'], ['share-group-link', 'icon-share']]) {
    check(`${icon} is drawn (not blank)`, (await id(btn).getByTestId(icon).count()) === 1)
    const r = await ink(btn, `/workspace/eng-scratch/shots/${icon}.png`)
    check(`${icon}: ink is visible and ${r.w}x${r.h}px`, r.n > 20 && r.w >= 8 && r.h >= 8 && r.w <= 28 && r.h <= 28, JSON.stringify(r))
    check(`${icon}: ink is centred in the button (±1px)`, Math.abs(r.cx) <= 1 && Math.abs(r.cy) <= 1, `cx=${r.cx} cy=${r.cy}`)
  }
  // top gap under the (web: zero) inset: the back button starts 18+8 below the top on web
  const top = (await id('back-to-groups').boundingBox()).y
  check('web header sits 26px from the top (no extra inset on web)', Math.abs(top - 26) <= 1, `y=${top}`)

  // one-slide dismiss: record the panel's translateY every frame from release to unmount
  await id('back-to-groups').click(); await id('create-group-card').waitFor()
  await id('create-group-card').click(); await id('create-group-sheet').waitFor(); await p.waitForTimeout(500)
  const pill = await id('sheet-pill').boundingBox(); const x = pill.x + pill.width / 2, y = pill.y + pill.height / 2
  await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x, y + 60); await p.mouse.move(x, y + 130)
  await p.evaluate(() => {
    window.__ys = []
    const tick = () => {
      const el = document.querySelector('[data-testid="create-group-sheet"]')
      window.__ys.push(el ? el.getBoundingClientRect().y : null)
      if (el) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await p.mouse.up(); await p.waitForTimeout(1200)
  const ys = (await p.evaluate(() => window.__ys)).filter((v) => v !== null)
  let back = 0; for (let i = 1; i < ys.length; i++) back = Math.max(back, ys[i - 1] - ys[i])
  check('the sheet unmounted after the flick', (await id('create-group-sheet').count()) === 0)
  check('the panel never moves back up while closing (single slide)', ys.length >= 3 && back <= 0.5, `frames=${ys.length} maxBackStep=${back.toFixed(2)} ys=${ys.map((v) => Math.round(v)).join(',')}`)
  check('no page errors', errors.length === 0, errors.join('|'))
  await browser.close()
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
