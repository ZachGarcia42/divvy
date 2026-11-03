// Browser check for receipt photos on the web build: attach on a new expense, view full screen, replace, remove, and the
// server-side facts (resized JPEG, history rows, no photo without a sign-in). Uses a generated 2400x1800 PNG.
// Usage: NODE_PATH=<dir with playwright> node e2e/photos.cjs http://127.0.0.1:18821 <TOKEN>
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) fails++ }
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` } // local date, not UTC (UTC is tomorrow after 4 PM PT)

function crc(buf) {
  let c, crcv = 0xffffffff
  for (let n = 0; n < buf.length; n++) { c = (crcv ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcv = (crcv >>> 8) ^ c }
  return (crcv ^ 0xffffffff) >>> 0
}
function png(width, height, shade) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) { row[1 + x * 3] = (x * 255 / width) | 0; row[2 + x * 3] = shade; row[3 + x * 3] = 90 }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue }
    const marker = bytes[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
    i += 2 + bytes.readUInt16BE(i + 2)
  }
  return null
}

;(async () => {
  const [base, TOKEN] = process.argv.slice(2)
  const { browser, p, id, api, gid, ids, errors } = await start(base, TOKEN)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'divvy-photos-'))
  const fileA = path.join(dir, 'receipt-a.png'); fs.writeFileSync(fileA, png(2400, 1800, 40))
  const fileB = path.join(dir, 'receipt-b.png'); fs.writeFileSync(fileB, png(800, 1200, 200))
  const pick = async (testid, file) => {
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), id(testid).click()])
    await chooser.setFiles(file)
  }
  const photoOf = async (eid) => (await api(`/api/groups/${gid}/expenses/${eid}`)).photo
  const fetchPhoto = (eid, auth = true) => fetch(`${base}/api/groups/${gid}/expenses/${eid}/photo`, { headers: auth ? { authorization: `Bearer ${TOKEN}` } : {} })

  // 1. New expense with a receipt, through the Add sheet
  await id('add-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(350)
  await id('expense-amount').click(); await id('expense-amount').pressSequentially('18.50', { delay: 10 })
  await id('expense-description').click(); await id('expense-description').pressSequentially('QA receipt lunch', { delay: 10 })
  check('empty row offers "Add receipt"', await id('receipt-add').isVisible() && /Optional/.test(await id('receipt-add').innerText()))
  await id('receipt-add').click(); await id('receipt-source-sheet').waitFor()
  check('source sheet has Take photo, Choose from library, Cancel', (await id('receipt-take').count()) === 1 && (await id('receipt-library').count()) === 1 && (await id('receipt-cancel').count()) === 1)
  await pick('receipt-library', fileA)
  await id('receipt-attached').waitFor({ timeout: 8000 })
  check('row shows the attached receipt with Remove', /Receipt attached/.test(await id('receipt-attached').innerText()) && (await id('receipt-remove').count()) === 1)
  await id('sheet-cta').click()
  await id('add-sheet').waitFor({ state: 'detached', timeout: 15000 })
  const home = await api(`/api/groups/${gid}`)
  const created = home.expenses.find((e) => e.description === 'QA receipt lunch')
  check('the expense saved', !!created)
  const eid = created.id
  const info = await photoOf(eid)
  check('server has one photo for it', !!info && info.contentType === 'image/jpeg', JSON.stringify(info))
  const got = await fetchPhoto(eid)
  const bytes = Buffer.from(await got.arrayBuffer())
  const size = jpegSize(bytes)
  check('stored as a JPEG resized to 1600px on the long edge', got.status === 200 && !!size && size.width === 1600 && size.height === 1200, JSON.stringify(size))
  check('photo needs a sign-in', (await fetchPhoto(eid, false)).status === 401)
  check('photo is never cached or public', /no-store/.test(got.headers.get('cache-control') ?? '') && /private/.test(got.headers.get('cache-control') ?? ''))

  // 2. Detail: card, full screen
  await p.goto(base); await id(`group-${gid}`).click({ timeout: 3000 }).catch(() => {})
  await id(`expense-${eid}`).click({ timeout: 10000 }); await id('history').waitFor()
  await id('receipt-view').waitFor({ timeout: 8000 })
  check('detail shows the Receipt card', /Receipt photo/.test(await id('receipt-view').innerText()) && /View full size/.test(await id('receipt-view').innerText()))
  await id('receipt-view').click(); await id('receipt-viewer').waitFor()
  await p.waitForFunction(() => { const img = document.querySelector('[data-testid="receipt-viewer-image"]'); const el = img && (img.tagName === 'IMG' ? img : img.querySelector('img')); return el && el.complete && el.naturalWidth > 0 }, null, { timeout: 8000 }).catch(() => {})
  const loaded = await p.evaluate(() => { const i = [...document.querySelectorAll('[data-testid="receipt-viewer"] img, [data-testid="receipt-viewer"] [style*="background-image"]')]; return i.length })
  check('full-screen viewer opens with the picture', loaded > 0 && /Receipt · /.test(await id('receipt-viewer').innerText()))
  check('viewer offers Replace and Remove', (await id('receipt-replace').count()) === 1 && (await id('receipt-viewer-remove').count()) === 1)

  // 3. Replace from the viewer
  await id('receipt-replace').click(); await id('receipt-source-sheet').waitFor()
  await pick('receipt-library', fileB)
  await p.waitForFunction((x) => /Receipt replaced/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {})
  const info2 = await photoOf(eid)
  check('replace swaps the photo (new id)', !!info2 && info2.id !== info.id)
  const size2 = jpegSize(Buffer.from(await (await fetchPhoto(eid)).arrayBuffer()))
  check('smaller photo is not scaled up', size2 && size2.width === 800 && size2.height === 1200, JSON.stringify(size2))

  // 4. Remove from the viewer
  await id('receipt-view').click(); await id('receipt-viewer').waitFor()
  await id('receipt-viewer-remove').click()
  await p.waitForFunction(() => /Receipt removed/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {})
  check('remove deletes the photo', (await photoOf(eid)) === null && (await fetchPhoto(eid)).status === 404)
  await id('receipt-add').waitFor({ timeout: 5000 })
  check('detail goes back to a dashed "Add receipt"', /Add receipt/.test(await id('receipt-add').innerText()))
  await p.waitForFunction(() => /receipt photo/.test(document.querySelector('[data-testid="history"]')?.textContent ?? ''), null, { timeout: 6000 }).catch(() => {})
  const hist = (await id('history').innerText()).split('\n').filter((l) => /receipt photo/.test(l))
  check('History records add, replace and remove', hist.length === 3 && /removed/.test(hist[0]) && /replaced/.test(hist[1]) && /added/.test(hist[2]), JSON.stringify(hist))

  // 5. Add from the detail screen, then edit sheet: remove before saving, cancel keeps it
  await id('receipt-add').click(); await id('receipt-source-sheet').waitFor()
  await pick('receipt-library', fileA)
  await p.waitForFunction(() => /Receipt added/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {})
  check('adding from the detail works', !!(await photoOf(eid)))
  await id('edit-expense').click(); await id('add-sheet').waitFor(); await p.waitForTimeout(300)
  check('edit sheet shows the receipt as attached', (await id('receipt-attached').count()) === 1)
  await id('receipt-remove').click()
  check('Remove in the sheet waits for Save', (await photoOf(eid)) !== null && (await id('receipt-add').count()) === 1)
  await id('sheet-cta').click(); await id('add-sheet').waitFor({ state: 'detached', timeout: 10000 })
  await p.waitForTimeout(500)
  check('Save then deletes it', (await photoOf(eid)) === null)

  // 6. The server decides by the file's bytes, not by what the client claims
  const second = await api(`/api/groups/${gid}/expenses`, 'POST', { description: 'QA keep', originalMinor: 1000, originalCurrency: 'USD', date: today(), payers: [{ participantId: ids[0], minor: 1000 }], split: { type: 'equal', participantIds: ids } })
  const sid = second.expense?.id ?? second.id
  const put = await fetch(`${base}/api/groups/${gid}/expenses/${sid}/photo`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/jpeg' }, body: fs.readFileSync(fileA) })
  check('a PNG sent as image/jpeg is accepted by its bytes', put.status === 200)
  const bad = await fetch(`${base}/api/groups/${gid}/expenses/${sid}/photo`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'image/jpeg' }, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') })
  check('an SVG is refused', bad.status === 400)

  check('no page errors', errors.length === 0, errors.join(' | '))
  await browser.close(); fs.rmSync(dir, { recursive: true, force: true })
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
