// Browser checks: Activity split by group. The Activity tab shows one section per group (latest activity first, newest first inside,
// four rows and "Show N more"), a chips row narrows it to one group, "See all" does the same, each group's own screen opens its
// activity, and back from a row returns to the same filter and scroll.
// Usage: NODE_PATH=<dir with playwright> node e2e/feed-groups.cjs http://127.0.0.1:18799 <TOKEN> [screenshot.png]
const fs = require('fs')
const { start } = require('./common.cjs')
let fails = 0
const check = (name, ok, extra = '') => { console.log(ok ? 'PASS' : 'FAIL', name, extra); if (!ok) fails++ }
;(async () => {
  const [base, TOKEN, shot] = process.argv.slice(2)
  const { browser, p, id, api, gid: tahoe, ids, errors } = await start(base, TOKEN, { viewport: { width: 390, height: 960 }, members: 2 })
  const day = new Date().toISOString().slice(0, 10)
  const add = async (groupId, you, description, minor, other) => {
    const r = await api(`/api/groups/${groupId}/expenses`, 'POST', { description, date: day, originalMinor: minor, originalCurrency: 'USD', payers: [{ participantId: you, minor }], split: { type: 'equal', participantIds: [you, other] } })
    if (!r.id) throw new Error(`could not add ${description}: ${JSON.stringify(r)}`)
    return r.id
  }
  const make = async (name) => { const g = (await api('/api/groups', 'POST', { name, currency: 'USD', timezone: 'America/Los_Angeles' })).group.id; const d = await api(`/api/groups/${g}`); const friend = (await api(`/api/groups/${g}/people`, 'POST', { displayName: 'Maya' })).participantId; return [g, d.yourParticipantId, friend] }
  const [mission, missionYou, missionMaya] = await make('🏠 Mission St apartment')
  const [nopa, nopaYou, nopaMaya] = await make('🍜 Thursday dinners')
  const tahoeYou = ids[0]
  // Oldest to newest: Nopa, Mission x2, Tahoe x7, then one more Mission. So the sections run Mission, Tahoe, Nopa.
  await add(nopa, nopaYou, 'Dinner at Nopa', 9600, nopaMaya)
  await add(mission, missionYou, 'Internet bill', 7999, missionMaya)
  await add(mission, missionYou, 'Parking', 1800, missionMaya)
  for (const [name, minor] of [['Cabin deposit', 34560], ['Groceries', 12000], ['Gas, drive up', 6400], ['Firewood', 2200], ['Lift tickets', 34560], ['Hot tub', 4500], ['Snacks', 1850]]) await add(tahoe, tahoeYou, name, minor, ids[1])
  const lastMission = await add(mission, missionYou, 'Electric bill', 5410, missionMaya)

  const rows = (scope) => (scope || p).locator('[role="button"][data-testid^="feed-"]')
  const sectionOrder = async () => (await p.locator('[data-testid^="activity-section-"]:not([data-testid^="activity-section-more-"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('activity-section-', ''))))
  const chipOrder = async () => (await id('activity-filter').locator('[role="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('activity-chip-', ''))))

  // ── the all-groups feed, split by group ──
  await p.reload(); await id('tab-activity').waitFor({ timeout: 15000 }).catch(() => {})
  // start() leaves the app on a group; the tab is on the groups screens
  await id('back-to-groups').click({ timeout: 3000 }).catch(() => {})
  await id('tab-activity').click()
  await id(`activity-section-${tahoe}`).waitFor({ timeout: 15000 })
  check('sections are in order of most recent activity (Mission, Tahoe, Nopa)', JSON.stringify(await sectionOrder()) === JSON.stringify([mission, tahoe, nopa]), JSON.stringify(await sectionOrder()))
  const titles = await p.locator('[data-testid^="activity-section-"]:not([data-testid^="activity-section-more-"]) [role="heading"]').allInnerTexts()
  check('each section has the group name as its header', titles.join('|') === 'Mission St apartment|Tahoe|Thursday dinners', titles.join('|'))
  check('a section with 3 entries (2 adds + 1) shows them all with no Show more', (await rows(id(`activity-section-${mission}`)).count()) === 3 && (await id(`activity-section-more-${mission}`).count()) === 0)
  check('a long section shows 4 rows and "Show 3 more"', (await rows(id(`activity-section-${tahoe}`)).count()) === 4 && /^Show 3 more/.test((await id(`activity-section-more-${tahoe}`).innerText()).trim()))
  const tahoeTitles = async () => (await rows(id(`activity-section-${tahoe}`)).locator('xpath=.//*[contains(@class,"r-") and string-length(normalize-space(text()))>0][1]').count(), await rows(id(`activity-section-${tahoe}`)).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))
  const first = await tahoeTitles()
  check('newest first inside a section (Snacks, Hot tub, Lift tickets, Firewood)', first.map((l) => (l.match(/“(.*?)”/) || [])[1]).join('|') === 'Snacks|Hot tub|Lift tickets|Firewood', first.join(' // '))
  check('rows in a section say the day, not the group ("Today · 3:42 PM")', /Today · \d+:\d\d [AP]M/.test(first[0]) && !/Tahoe/.test(first[0].replace(/^.*\. /, '')), first[0])
  const lastMine = await rows(id(`activity-section-${mission}`)).first().getAttribute('aria-label')
  check('the Mission section leads with its newest entry', /Electric bill/.test(lastMine), lastMine)
  check('chips: All + each group, in the sections\' order', JSON.stringify(await chipOrder()) === JSON.stringify(['all', mission, tahoe, nopa]), JSON.stringify(await chipOrder()))
  check('All is the selected chip', (await id('activity-chip-all').getAttribute('aria-selected')) === 'true' && (await id(`activity-chip-${tahoe}`).getAttribute('aria-selected')) === 'false')
  if (shot) { fs.mkdirSync(require('path').dirname(shot), { recursive: true }); await p.waitForTimeout(400); await p.screenshot({ path: shot }); console.log('shot', shot) }

  // ── show more / show less ──
  check('the header counts the group\'s entries: See all (7)', /See all \(7\)/.test(await id(`activity-seeall-${tahoe}`).innerText()))
  await id(`activity-section-more-${tahoe}`).click()
  await p.waitForFunction((sel) => document.querySelectorAll(`${sel} [role="button"][data-testid^="feed-"]`).length === 7, `[data-testid="activity-section-${tahoe}"]`)
  check('Show more opens the section (7 rows), no more to show, and offers Show less', (await rows(id(`activity-section-${tahoe}`)).count()) === 7 && (await id(`activity-section-more-${tahoe}`).count()) === 0 && /^Show less/.test((await id(`activity-section-less-${tahoe}`).innerText()).trim()))
  check('other sections stay as they were', (await rows(id(`activity-section-${nopa}`)).count()) === 1 && (await rows(id(`activity-section-${mission}`)).count()) === 3)
  await id(`activity-section-less-${tahoe}`).click()
  check('Show less folds it back to 4, with Show 3 more again', (await rows(id(`activity-section-${tahoe}`)).count()) === 4 && /^Show 3 more/.test(await id(`activity-section-more-${tahoe}`).innerText()))

  // ── a chip narrows to one group ──
  await id(`activity-chip-${nopa}`).click()
  await p.waitForFunction(() => document.querySelectorAll('[data-testid^="activity-section-"]').length === 0)
  await rows().first().waitFor()
  const nopaRows = await rows().evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  check('the Nopa chip shows only Nopa activity, under day headings', nopaRows.length === 1 && /Dinner at Nopa/.test(nopaRows[0]) && (await p.getByRole('heading', { name: /TODAY/ }).count()) === 1, nopaRows.join(' // '))
  check('the chip is selected and the title names the group', (await id(`activity-chip-${nopa}`).getAttribute('aria-selected')) === 'true' && (await p.getByText('Everything that happened in Thursday dinners, newest first.').count()) === 1)
  check('filtered rows do not repeat the group name', !/Thursday dinners/.test(nopaRows[0].replace(/Dinner at Nopa/, '')))
  await id(`activity-chip-${tahoe}`).click()
  await p.waitForFunction(() => document.querySelectorAll('[role="button"][data-testid^="feed-"]').length === 7)
  check('the Tahoe chip shows all 7 Tahoe rows (no folding), newest first', (await rows().count()) === 7 && /Snacks/.test(await rows().first().getAttribute('aria-label')))
  await id('activity-chip-all').click()
  await id(`activity-section-${tahoe}`).waitFor()
  check('All goes back to the sections', JSON.stringify(await sectionOrder()) === JSON.stringify([mission, tahoe, nopa]))

  // ── See all ──
  await id(`activity-seeall-${mission}`).click()
  await p.waitForFunction(() => document.querySelectorAll('[data-testid^="activity-section-"]').length === 0)
  await rows().first().waitFor({ timeout: 8000 })
  check('"See all" on a section opens that group\'s chip', (await id(`activity-chip-${mission}`).getAttribute('aria-selected')) === 'true' && (await rows().count()) === 3)

  // ── a row opens its expense, and back returns to the same filter ──
  await rows().first().click()
  await id('back-to-group').waitFor({ timeout: 8000 })
  await id('back-to-group').click()
  await id(`activity-chip-${mission}`).waitFor({ timeout: 8000 })
  check('back from a row lands on the same filter', (await id(`activity-chip-${mission}`).getAttribute('aria-selected')) === 'true' && (await rows().count()) === 3)

  // ── an empty group has a chip, and an honest empty state ──
  const [quiet] = await make('🎲 Quiet group')
  await id('tab-groups').click(); await id('tab-activity').click()
  await id(`activity-chip-${quiet}`).waitFor({ timeout: 10000 })
  check('a group with no activity yet still has a chip, last', (await chipOrder()).slice(-1)[0] === quiet)
  await id(`activity-chip-${quiet}`).click()
  await id('activity-empty').waitFor({ timeout: 8000 })
  check('its empty state names the group and offers Open group', (await id('activity-empty-action').innerText()).trim() === 'Open group')
  await id('activity-empty-action').click()
  await id('add-expense').waitFor({ timeout: 8000 })
  await p.getByText('Quiet group').first().waitFor({ timeout: 8000 }).catch(() => {})
  check('Open group opens that group', (await p.getByText('Quiet group').count()) > 0)

  // ── a very busy group does not crowd the others out of All, and the picked chip is always in view ──
  const [oldQuiet, oldQuietYou, oldQuietMaya] = await make('🪴 Old and quiet')
  await add(oldQuiet, oldQuietYou, 'Plant food', 1200, oldQuietMaya)
  const [busy, busyYou, busyMaya] = await make('🔥 Busy group')
  for (let i = 0; i < 65; i += 13) await Promise.all(Array.from({ length: 13 }, (_, j) => add(busy, busyYou, `Busy ${i + j}`, 100 + i + j, busyMaya)))
  await id('tab-groups').click(); await id('tab-activity').click()
  await id('activity-chip-all').click()   // the filter (Quiet group) is still set from before
  await id(`activity-section-${busy}`).waitFor({ timeout: 15000 })
  await id(`activity-section-${oldQuiet}`).waitFor({ timeout: 15000 })
  const order = await sectionOrder()
  check('the busy group leads, and the quiet one still has its section', order[0] === busy && order.includes(oldQuiet) && order.includes(mission) && order.includes(nopa), JSON.stringify(order))
  check('the busy section: 4 rows and an honest "Show 61 more" and "See all (65)"', (await rows(id(`activity-section-${busy}`)).count()) === 4 && /^Show 61 more/.test(await id(`activity-section-more-${busy}`).innerText()) && /See all \(65\)/.test(await id(`activity-seeall-${busy}`).innerText()))
  check('the quiet section shows its one entry, nothing to show more of', (await rows(id(`activity-section-${oldQuiet}`)).count()) === 1 && (await id(`activity-section-more-${oldQuiet}`).count()) === 0 && /See all \(1\)/.test(await id(`activity-seeall-${oldQuiet}`).innerText()))
  check('no "Show older activity" button: every group is already there', (await id('activity-older').count()) === 0)
  await id(`activity-section-more-${busy}`).click()
  await p.waitForFunction((sel) => document.querySelectorAll(`${sel} [role="button"][data-testid^="feed-"]`).length === 30, `[data-testid="activity-section-${busy}"]`)
  check('Show more brings the next batch (30 rows) and counts what is left (Show 35 more)', /^Show 35 more/.test(await id(`activity-section-more-${busy}`).innerText()) && (await id(`activity-section-less-${busy}`).count()) === 1)
  await id(`activity-section-more-${busy}`).click()
  await p.waitForFunction((sel) => document.querySelectorAll(`${sel} [role="button"][data-testid^="feed-"]`).length === 60, `[data-testid="activity-section-${busy}"]`)
  await id(`activity-section-more-${busy}`).click()
  await p.waitForFunction((sel) => document.querySelectorAll(`${sel} [role="button"][data-testid^="feed-"]`).length === 65, `[data-testid="activity-section-${busy}"]`)
  check('and the last batch ends it: 65 rows, only Show less left', (await id(`activity-section-more-${busy}`).count()) === 0 && (await id(`activity-section-less-${busy}`).count()) === 1)
  await id(`activity-section-less-${busy}`).click()

  const inView = async (key) => {
    const [fb, cb] = await Promise.all([id('activity-filter').boundingBox(), id(`activity-chip-${key}`).boundingBox()])
    return !!fb && !!cb && cb.x >= fb.x - 1 && cb.x + cb.width <= fb.x + fb.width + 1
  }
  check('All starts in view', await inView('all'))
  check('the last chip starts off screen to the right (the setup is a real test)', !(await inView(nopa)))
  await id(`activity-seeall-${nopa}`).click()
  await p.waitForTimeout(900)
  check('"See all" on the last group scrolls its chip into view, selected', (await inView(nopa)) && (await id(`activity-chip-${nopa}`).getAttribute('aria-selected')) === 'true')
  await id('tab-groups').click(); await id('tab-activity').click()
  await p.waitForTimeout(700)
  check('coming back to a filter that is already set shows its chip, too', (await inView(nopa)) && (await id(`activity-chip-${nopa}`).getAttribute('aria-selected')) === 'true')
  await id('activity-chip-all').click()
  await p.waitForTimeout(700)
  check('All brings the row back to the start', await inView('all') && !(await inView(nopa)))

  // ── the group's own screen reaches its activity ──
  await id('tab-groups').click(); await id(`group-${tahoe}`).click(); await id('group-activity').click()
  await id('activity-group-chip').waitFor({ timeout: 8000 })
  await rows().first().waitFor({ timeout: 8000 })
  check('the group screen\'s Activity button opens only that group\'s feed', (await rows().count()) === 7 && (await id('activity-group-chip').innerText()).includes('Tahoe') && (await p.locator('[data-testid^="activity-chip-"]').count()) === 0, `rows=${await rows().count()} chip=${await id('activity-group-chip').innerText()} chips=${await p.locator('[data-testid^="activity-chip-"]').count()}`)
  await id('back-from-activity').click(); await id('add-expense').waitFor()
  check('and back returns to the group', (await id('add-expense').count()) === 1)

  // ── the new line on the API: ?groupId= on /api/feed ──
  const one = await api(`/api/feed?groupId=${mission}`)
  check('GET /api/feed?groupId= returns one group\'s page', one.items.length === 3 && one.items.every((i) => i.group.id === mission) && one.items[0].id === (await api(`/api/groups/${mission}/feed`)).items[0].id)
  const status = async (path) => (await fetch(base + path, { headers: { authorization: `Bearer ${TOKEN}` } })).status
  const nul = [await status('/api/feed?groupId=%00'), await status('/api/groups/%00'), await status('/api/groups/%00/feed'), await status('/api/groups/a%00b/expenses'), await status('/api/feed/sections?groupId=x%00')]
  check('a malformed group id (NUL) is a 404 on every route, not a 500', nul.every((n) => n === 404), nul.join(','))
  const sec = await api('/api/feed/sections')
  check('GET /api/feed/sections: one section per group with activity, totals counted, 4 items each', sec.sections.length === 5 && sec.sections.every((x) => x.items.length === Math.min(4, x.total)) && sec.sections.find((x) => x.group.id === busy).total === 65, sec.sections.map((x) => x.group.name + ':' + x.total).join(','))
  check('no page errors', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(fails ? `${fails} FAIL` : 'ALL PASS')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
