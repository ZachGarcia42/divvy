import { describe, expect, it } from 'vitest'
import type { SplitMethod } from '@divvy/domain'
import { amountTooLarge, sanitizeAmountText, adjustDisplay, adjustSign, adjustTyped, toggleAdjustSign, bpsText, draftFromSpec, evaluate, groupedMajor, isDirty, newDraft, parseAmountText, parsePercentBps, sharesFromWeights, switchMethod, type Draft } from './split'

const ids = ['you', 'maya', 'leo', 'priya']
const names: Record<string, string> = { you: 'You', maya: 'Maya', leo: 'Leo', priya: 'Priya' }
const nameOf = (id: string) => names[id] ?? id
const ev = (draft: ReturnType<typeof newDraft>, amount: string, payer: string | null = 'you', members = ids) => evaluate(draft, members, amount, 'USD', payer, nameOf)
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

it('treats a bare sign as zero', () => {
  expect(parseAmountText('-', 'USD', true)).toBe(0)
  expect(parseAmountText('+', 'USD', true)).toBe(0)
})

describe('split editor: Equal (default)', () => {
  it('starts Equal with everyone included, amount first, and is invalid until there is an amount', () => {
    const draft = newDraft(ids)
    expect(draft.method).toBe('equal')
    expect(Object.values(draft.included).every(Boolean)).toBe(true)
    const none = ev(draft, '')
    expect(none.ok).toBe(false)
    expect(none.cta).toBe('Enter an amount')
    const ok = ev(draft, '120')
    expect(ok).toMatchObject({ ok: true, cta: 'Add expense' })
    expect(ok.results).toEqual({ you: 3000, maya: 3000, leo: 3000, priya: 3000 })
    expect(ok.bar).toEqual({ tone: 'ok', left: '$30.00 each · 4 people', right: '✓ Adds up' })
  })
  it('shows who got the extra cent, the payer first', () => {
    const three = ids.slice(0, 3)
    const draft = newDraft(three)
    const r = ev(draft, '10', 'leo', three)
    expect(r.results).toEqual({ you: 333, maya: 333, leo: 334 })
    expect(r.bar.left).toBe('$3.33 each · 3 people · +$0.01 to Leo')
    const other = ev(draft, '10', 'you', three)
    expect(other.results).toEqual({ you: 334, maya: 333, leo: 333 })
    // the payer is not in the split: the cent goes down the list in member order
    expect(ev(draft, '10', 'zed', three).results).toEqual({ you: 334, maya: 333, leo: 333 })
  })
  it('cannot save with nobody included, and accepts comma amounts up to the cap', () => {
    const draft = { ...newDraft(ids), included: { you: false, maya: false, leo: false, priya: false } }
    expect(ev(draft, '10').ok).toBe(false)
    expect(ev(newDraft(ids), '1,000.50').results.you).toBe(25013)
    expect(ev(newDraft(ids), '100000').ok).toBe(true)
    expect(ev(newDraft(ids), '100000.01').ok).toBe(false)
  })
})

describe('split editor: carry over when switching', () => {
  it('Equal $40/$40/$40 becomes Exact 40/40/40, and back', () => {
    const three = ids.slice(0, 3)
    const eq = newDraft(three)
    const exact = switchMethod(eq, 'exact', three, '120', 'USD', 'you')
    expect(exact.method).toBe('exact')
    expect(exact.exact).toEqual({ you: '40.00', maya: '40.00', leo: '40.00' })
    expect(ev(exact, '120', 'you', three).ok).toBe(true)
    const pct = switchMethod(exact, 'percent', three, '120', 'USD', 'you')
    expect(pct.percent).toEqual({ you: '33.34', maya: '33.33', leo: '33.33' })
    // 1/3 has no exact percent, so Percent is the one method that carries approximately (always adds up to the total)
    const viaPercent = ev(pct, '120', 'you', three).results
    expect(sum(viaPercent)).toBe(12000)
    for (const id of three) expect(Math.abs(viaPercent[id]! - 4000)).toBeLessThanOrEqual(1)
    const sh = switchMethod(pct, 'shares', three, '120', 'USD', 'you')
    expect(sh.shares).toEqual({ you: 1, maya: 1, leo: 1 })
    const adj = switchMethod(sh, 'adjust', three, '120', 'USD', 'you')
    expect(adj.adjust).toEqual({ you: '', maya: '', leo: '' })
    const back = switchMethod(adj, 'equal', three, '120', 'USD', 'you')
    expect(back.included).toEqual({ you: true, maya: true, leo: true })
  })
  it('carries an uneven split exactly, including into Adjust', () => {
    const draft = { ...newDraft(ids), method: 'exact' as const, exact: { you: '40', maya: '35', leo: '30', priya: '15' } }
    const toAdjust = switchMethod(draft, 'adjust', ids, '120', 'USD', 'you')
    expect(toAdjust.adjust).toEqual({ you: '+10.00', maya: '+5.00', leo: '', priya: '-15.00' })
    expect(ev(toAdjust, '120').results).toEqual({ you: 4000, maya: 3500, leo: 3000, priya: 1500 })
    const toShares = switchMethod(draft, 'shares', ids, '120', 'USD', 'you')
    expect(toShares.shares).toEqual({ you: 8, maya: 7, leo: 6, priya: 3 })
    expect(ev(toShares, '120').results).toEqual({ you: 4000, maya: 3500, leo: 3000, priya: 1500 })
    const toPercent = switchMethod(draft, 'percent', ids, '120', 'USD', 'you')
    const viaPercent = ev(toPercent, '120').results
    expect(sum(viaPercent)).toBe(12000)
    expect(Math.abs(viaPercent.maya! - 3500)).toBeLessThanOrEqual(2)
    const toEqual = switchMethod({ ...draft, exact: { you: '60', maya: '60', leo: '', priya: '' } }, 'equal', ids, '120', 'USD', 'you')
    expect(toEqual.included).toEqual({ you: true, maya: true, leo: false, priya: false })
  })
  it('does not invent numbers from an invalid split, and keeps the target as it was', () => {
    const draft = { ...newDraft(ids), method: 'exact' as const, exact: { you: '40', maya: '', leo: '', priya: '' } }
    const next = switchMethod(draft, 'percent', ids, '120', 'USD', 'you')
    expect(next.method).toBe('percent')
    expect(next.percent).toEqual({ you: '', maya: '', leo: '', priya: '' })
    expect(switchMethod(draft, 'exact', ids, '120', 'USD', 'you')).toBe(draft)
  })
  it('carries before an amount is typed (even weights)', () => {
    const next = switchMethod({ ...newDraft(ids), included: { you: true, maya: true, leo: false, priya: false } }, 'percent', ids, '', 'USD', 'you')
    expect(next.percent).toEqual({ you: '50', maya: '50', leo: '', priya: '' })
  })
  it('reduces share weights', () => {
    expect(sharesFromWeights([4000, 2000, 2000])).toEqual([2, 1, 1])
    expect(sharesFromWeights([3334, 3333, 3333])).toEqual([1, 1, 1])
    expect(sharesFromWeights([0, 5, 5])).toEqual([0, 1, 1])
    expect(Math.max(...sharesFromWeights([99999, 1234, 777]))).toBeLessThanOrEqual(100)
  })
})

describe('split editor: Exact', () => {
  const draft = (exact: Record<string, string>) => ({ ...newDraft(ids), method: 'exact' as const, exact })
  it('says what is left and what is over, and only saves when it adds up', () => {
    const left = ev(draft({ you: '40', maya: '35', leo: '30', priya: '12' }), '120')
    expect(left).toMatchObject({ ok: false, cta: 'Fix the split to save' })
    expect(left.bar).toEqual({ tone: 'bad', left: '$117.00 of $120.00', right: '$3.00 left' })
    const over = ev(draft({ you: '40', maya: '35', leo: '30', priya: '20' }), '120')
    expect(over.bar.right).toBe('$5.00 over')
    const good = ev(draft({ you: '40', maya: '35', leo: '30', priya: '15' }), '120')
    expect(good.ok).toBe(true)
    expect(good.spec).toEqual({ type: 'exact', amounts: [{ participantId: 'you', minor: 4000 }, { participantId: 'maya', minor: 3500 }, { participantId: 'leo', minor: 3000 }, { participantId: 'priya', minor: 1500 }] })
  })
  it('blank counts as 0, junk is refused, and zero-share people are left out of the request', () => {
    const r = ev(draft({ you: '120', maya: '', leo: '0', priya: '' }), '120')
    expect(r.ok).toBe(true)
    expect(r.spec).toEqual({ type: 'exact', amounts: [{ participantId: 'you', minor: 12000 }] })
    expect(ev(draft({ you: 'abc', maya: '', leo: '', priya: '' }), '120').ok).toBe(false)
    expect(ev(draft({ you: '1.234', maya: '', leo: '', priya: '' }), '120').ok).toBe(false)
  })
})

describe('split editor: Percent', () => {
  const draft = (percent: Record<string, string>) => ({ ...newDraft(ids), method: 'percent' as const, percent })
  it('reports left/over in percent and divides the total by the percents', () => {
    const over = ev(draft({ you: '40', maya: '30', leo: '20', priya: '20' }), '120')
    expect(over).toMatchObject({ ok: false })
    expect(over.bar).toEqual({ tone: 'bad', left: '110% of 100%', right: '10% over' })
    expect(ev(draft({ you: '40', maya: '30', leo: '20', priya: '' }), '120').bar.right).toBe('10% left')
    const good = ev(draft({ you: '40', maya: '30', leo: '20', priya: '10' }), '120')
    expect(good.results).toEqual({ you: 4800, maya: 3600, leo: 2400, priya: 1200 })
  })
  it('puts leftover cents on the payer first', () => {
    const three = ids.slice(0, 3)
    const d = { ...newDraft(three), method: 'percent' as const, percent: { you: '33.33', maya: '33.33', leo: '33.34' } }
    const r = ev(d, '0.10', 'maya', three)
    expect(sum(r.results)).toBe(10)
  })
  it('parses percent text', () => {
    expect(parsePercentBps('33.33')).toBe(3333)
    expect(parsePercentBps(' 40 % ')).toBe(4000)
    expect(parsePercentBps('')).toBe(0)
    expect(parsePercentBps('1.234')).toBeNull()
    expect(parsePercentBps('-5')).toBeNull()
    expect(bpsText(4000)).toBe('40')
    expect(bpsText(3333)).toBe('33.33')
    expect(bpsText(1050)).toBe('10.5')
  })
})

describe('split editor: Shares', () => {
  it('splits by weights, shows the amount per share, and needs at least one share', () => {
    const d = { ...newDraft(ids), method: 'shares' as const, shares: { you: 2, maya: 1, leo: 1, priya: 2 } }
    const r = ev(d, '120')
    expect(r.results).toEqual({ you: 4000, maya: 2000, leo: 2000, priya: 4000 })
    expect(r.bar).toEqual({ tone: 'ok', left: '6 shares · $20.00 per share', right: '✓ Adds up' })
    const zero = ev({ ...d, shares: { you: 0, maya: 0, leo: 0, priya: 0 } }, '120')
    expect(zero.ok).toBe(false)
  })
  it('leftover cents go to the payer first', () => {
    const d = { ...newDraft(ids), method: 'shares' as const, shares: { you: 1, maya: 1, leo: 1, priya: 0 } }
    expect(ev(d, '10', 'leo').results).toEqual({ you: 333, maya: 333, leo: 334 })
  })
})

describe('split editor: Adjust', () => {
  const draft = (adjust: Record<string, string>) => ({ ...newDraft(ids), method: 'adjust' as const, adjust })
  it('adds adjustments on top of an equal split of what is left (the design example)', () => {
    const r = ev(draft({ you: '', maya: '', leo: '+10', priya: '' }), '120')
    expect(r.results).toEqual({ you: 2750, maya: 2750, leo: 3750, priya: 2750 })
    expect(r.bar).toEqual({ tone: 'ok', left: '$110.00 split 4 ways + $10.00', right: '✓ Adds up' })
  })
  it('is invalid when adjustments exceed the total', () => {
    const r = ev(draft({ you: '', maya: '50', leo: '60', priya: '20' }), '120')
    expect(r.ok).toBe(false)
    expect(r.bar).toEqual({ tone: 'bad', left: 'Adjustments $130.00', right: '$10.00 over total' })
    expect(r.cta).toBe('Fix the split to save')
  })
  it('is invalid when someone would end up below zero, even though the total matches', () => {
    const r = ev(draft({ you: '-50', maya: '', leo: '', priya: '' }), '120')
    expect(r.ok).toBe(false)
    expect(r.bar.left).toBe('Someone would owe less than zero')
    const fine = ev(draft({ you: '-10', maya: '', leo: '', priya: '' }), '120')
    expect(fine.results).toEqual({ you: 2250, maya: 3250, leo: 3250, priya: 3250 })
    expect(sum(fine.results)).toBe(12000)
  })
  it('parses signed text', () => {
    expect(parseAmountText('+10', 'USD', true)).toBe(1000)
    expect(parseAmountText('-2.50', 'USD', true)).toBe(-250)
    expect(parseAmountText('−2.50', 'USD', true)).toBe(-250)
    expect(parseAmountText('', 'USD', true)).toBe(0)
    expect(() => parseAmountText('-2', 'USD', false)).toThrow()
  })
})

describe('split editor: editing and discard', () => {
  it('rebuilds the editor from a stored split', () => {
    const d = draftFromSpec({ type: 'shares', parts: [{ participantId: 'you', weight: 2 }, { participantId: 'maya', weight: 1 }] }, ids, 'USD')
    expect(d.method).toBe('shares')
    expect(d.shares).toEqual({ you: 2, maya: 1, leo: 0, priya: 0 })
    const a = draftFromSpec({ type: 'adjust', parts: ids.map((id, i) => ({ participantId: id, minor: i === 2 ? 1000 : i === 3 ? -250 : 0 })) }, ids, 'USD')
    expect(a.adjust).toEqual({ you: '', maya: '', leo: '+10.00', priya: '-2.50' })
    expect(ev(a, '120').ok).toBe(true)
    const e = draftFromSpec({ type: 'equal', participantIds: ['you', 'leo'] }, ids, 'USD')
    expect(e.included).toEqual({ you: true, maya: false, leo: true, priya: false })
    const x = draftFromSpec({ type: 'exact', amounts: [{ participantId: 'you', minor: 5 }] }, ids, 'USD')
    expect(x.exact.you).toBe('0.05')
    expect(draftFromSpec({ type: 'percent', parts: [{ participantId: 'you', bps: 3333 }] }, ids, 'USD').percent.you).toBe('33.33')
    expect(draftFromSpec(null, ids, 'USD')).toEqual(newDraft(ids))
  })
  it('asks to discard only when something was entered', () => {
    expect(isDirty('', '', newDraft(ids), ids)).toBe(false)
    expect(isDirty('1', '', newDraft(ids), ids)).toBe(true)
    expect(isDirty('', ' x', newDraft(ids), ids)).toBe(true)
    expect(isDirty('', '', { ...newDraft(ids), method: 'exact' }, ids)).toBe(true)
  })
})

describe('lossless carry-over between methods', () => {
  const exactDraft = (amount: string, cells: string[], payer: string | null = 'you') => {
    const d = { ...newDraft(ids), method: 'exact' as const, exact: Object.fromEntries(ids.map((id, i) => [id, cells[i] ?? ''])) }
    expect(ev(d, amount, payer).ok).toBe(true)
    return d
  }
  it('Exact 2.51/3.50/2.50/1.50 on $10.01 keeps its cents when switched to %', () => {
    const exact = exactDraft('10.01', ['2.51', '3.50', '2.50', '1.50'])
    const pct = switchMethod(exact, 'percent', ids, '10.01', 'USD', 'you')
    const out = ev(pct, '10.01')
    expect(out.ok).toBe(true)
    expect(out.results).toEqual({ you: 251, maya: 350, leo: 250, priya: 150 })
    // what is sent carries the cents too, and the server accepts it as a rounding of the percents
    expect(out.spec).toMatchObject({ type: 'percent' })
    const spec = out.spec as { parts: { participantId: string; bps: number; minor?: number }[] }
    expect(spec.parts.map((p) => p.minor)).toEqual([251, 350, 250, 150])
  })
  it('stops carrying once a percent or the amount is edited', () => {
    const pct = switchMethod(exactDraft('10.01', ['2.51', '3.50', '2.50', '1.50']), 'percent', ids, '10.01', 'USD', 'you')
    expect(ev(pct, '20').results).not.toEqual({ you: 251, maya: 350, leo: 250, priya: 150 })
    const edited = { ...pct, percent: { ...pct.percent, you: '25.09', leo: '24.96' } }
    const out = ev(edited, '10.01')
    expect((out.spec as { parts: { minor?: number }[] }).parts.every((p) => p.minor === undefined)).toBe(true)
  })
  it('is lossless Exact → % → Exact/Shares/Adjust for many totals, payers and shapes', () => {
    let checked = 0
    for (let total = 101; total < 60_000; total += 977) {
      for (const payer of ['you', 'leo', null]) {
        const weights = [3, 5, 2, 1]
        const sumW = weights.reduce((a, b) => a + b, 0)
        const cents = weights.map((w) => Math.floor((total * w) / sumW))
        cents[1]! += total - cents.reduce((a, b) => a + b, 0)
        const cell = (n: number) => `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`
        const amount = cell(total)
        const exact = exactDraft(amount, cents.map(cell), payer)
        const want = Object.fromEntries(ids.map((id, i) => [id, cents[i]!]))
        const pct = switchMethod(exact, 'percent', ids, amount, 'USD', payer)
        expect(ev(pct, amount, payer).results).toEqual(want)
        const back = switchMethod(pct, 'exact', ids, amount, 'USD', payer)
        expect(ev(back, amount, payer).results).toEqual(want)
        const shares = switchMethod(exact, 'shares', ids, amount, 'USD', payer)
        expect(ev(shares, amount, payer).results).toEqual(want)
        const adjust = switchMethod(exact, 'adjust', ids, amount, 'USD', payer)
        expect(ev(adjust, amount, payer).results).toEqual(want)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(100)
  })
  it('Equal with an uneven cent carries to % and Adjust without moving it', () => {
    const eq = { ...newDraft(ids), included: { you: false, maya: true, leo: true, priya: true } }
    const want = ev(eq, '10.01', 'maya').results
    for (const to of ['exact', 'percent', 'shares', 'adjust'] as const) {
      const next = switchMethod(eq, to, ids, '10.01', 'USD', 'maya')
      const got = ev(next, '10.01', 'maya').results
      expect(Object.fromEntries(ids.map((id) => [id, got[id] ?? 0]))).toEqual({ you: 0, ...want })
    }
  })
  it('an edit reopens a carried % split exactly', () => {
    const pct = switchMethod(exactDraft('10.01', ['2.51', '3.50', '2.50', '1.50']), 'percent', ids, '10.01', 'USD', 'you')
    const spec = ev(pct, '10.01').spec!
    const reopened = draftFromSpec(spec, ids, 'USD')
    expect(ev(reopened, '10.01').results).toEqual({ you: 251, maya: 350, leo: 250, priya: 150 })
  })
})

describe('groupedMajor', () => {
  it('shows amounts with thousands separators', () => {
    expect(groupedMajor(4886224, 'USD')).toBe('48,862.24')
    expect(groupedMajor(100, 'USD')).toBe('1.00')
    expect(groupedMajor(99999, 'USD')).toBe('999.99')
    expect(groupedMajor(100000, 'USD')).toBe('1,000.00')
    expect(groupedMajor(123456789012, 'USD')).toBe('1,234,567,890.12')
    expect(groupedMajor(1234567, 'JPY')).toBe('1,234,567')
    expect(groupedMajor(0, 'USD')).toBe('0.00')
  })
})

describe('round trips restore what was typed', () => {
  const adjustDraft = (cells: string[]) => ({ ...newDraft(ids), method: 'adjust' as const, adjust: Object.fromEntries(ids.map((id, i) => [id, cells[i] ?? ''])) })
  const trip = (draft: Draft, via: SplitMethod[], amount: string, payer: string | null = 'you') =>
    [...via, draft.method].reduce((d, to) => switchMethod(d, to, ids, amount, 'USD', payer), draft)

  it('Adjust +1.00/+0.50/0/0 → % → Adjust comes back as typed', () => {
    const typed = ['+1.00', '+0.50', '', '']
    const draft = adjustDraft(typed)
    expect(ev(draft, '10.01').ok).toBe(true)
    const back = trip(draft, ['percent'], '10.01')
    expect(back.method).toBe('adjust')
    expect(ids.map((id) => back.adjust[id])).toEqual(typed)
    expect(ev(back, '10.01').results).toEqual(ev(draft, '10.01').results)
  })
  it('restores the raw inputs across longer trips and for every method', () => {
    const typed = ['+1.00', '+0.50', '', '']
    const draft = adjustDraft(typed)
    for (const via of [['percent', 'shares'], ['exact'], ['shares', 'exact', 'percent']] as SplitMethod[][]) {
      const back = trip(draft, via, '10.01')
      expect(ids.map((id) => back.adjust[id]), via.join('>')).toEqual(typed)
    }
    const shares = { ...newDraft(ids), method: 'shares' as const, shares: { you: 3, maya: 2, leo: 0, priya: 1 } }
    const sBack = trip(shares, ['percent'], '12.34')
    expect(sBack.shares).toEqual({ you: 3, maya: 2, leo: 0, priya: 1 })
    const pct = { ...newDraft(ids), method: 'percent' as const, percent: { you: '33.33', maya: '33.33', leo: '33.34', priya: '' } }
    const pBack = trip(pct, ['exact'], '10.01')
    expect(pBack.percent).toEqual(pct.percent)
  })
  it('recomputes once anything changed in between (a cell, the amount)', () => {
    const draft = adjustDraft(['+1.00', '+0.50', '', ''])
    const inPct = switchMethod(draft, 'percent', ids, '10.01', 'USD', 'you')
    const edited = { ...inPct, percent: { ...inPct.percent, you: '40', maya: '30', leo: '20', priya: '10' } }
    const back = switchMethod(edited, 'adjust', ids, '10.01', 'USD', 'you')
    expect(ids.map((id) => back.adjust[id])).not.toEqual(['+1.00', '+0.50', '', ''])
    expect(ev(back, '10.01').results).toEqual(ev(edited, '10.01').results)
    const changedAmount = switchMethod(inPct, 'adjust', ids, '20.02', 'USD', 'you')
    expect(ev(changedAmount, '20.02').ok).toBe(true)
  })
})

// Interaction level: these replay what the sheet does for a person — key by key into an Adjust field (the field shows
// adjustDisplay(value) and onChangeText stores adjustTyped(value, text)), the +/- button, and the method tabs.
describe('driving the Adjust cells like the sheet does', () => {
  type D = ReturnType<typeof newDraft>
  const cell = (d: D, id: string) => adjustDisplay(d.adjust[id] ?? '')
  /** Select-all then type `text` one character at a time, as in a browser input. */
  const typeInto = (d: D, id: string, text: string): D => {
    let shown = ''
    let draft = d
    for (const ch of text) {
      shown += ch
      draft = { ...draft, adjust: { ...draft.adjust, [id]: adjustTyped(draft.adjust[id] ?? '', shown) } }
      shown = adjustDisplay(draft.adjust[id]!) === '' && /^[+\-−]*$/.test(shown) ? shown : adjustDisplay(draft.adjust[id]!)
    }
    return draft
  }
  const tab = (d: D, to: SplitMethod, amount = '10.01') => switchMethod(d, to, ids, amount, 'USD', 'you')
  const open = () => tab(newDraft(ids), 'adjust')
  const typedRow = () => ['+1.00', '+0.50', '0', '0'].reduce((d, text, i) => typeInto(d, ids[i]!, text), open())

  it('typing "+1.00" shows "+1.00", stores one sign, and is a valid adjustment', () => {
    const d = typeInto(open(), 'you', '+1.00')
    expect(d.adjust.you).toBe('+1.00')
    expect(cell(d, 'you')).toBe('+1.00')
    expect(ev(d, '10.01').ok).toBe(true)
  })
  it('the reported repro: +1.00 / +0.50 / 0 / 0 on $10.01 is valid, with no amount error', () => {
    const d = typedRow()
    expect(ids.map((id) => cell(d, id))).toEqual(['+1.00', '+0.50', '0', '0'])
    const out = ev(d, '10.01')
    expect(out.bar.right).toBe('✓ Adds up')
    expect(out.results).toEqual({ you: 313, maya: 263, leo: 213, priya: 212 })
  })
  it('Adjust > % > Shares > Adjust brings the typed cells back, not blanks', () => {
    const typed = typedRow()
    const back = tab(tab(tab(typed, 'percent'), 'shares'), 'adjust')
    expect(ids.map((id) => cell(back, id))).toEqual(['+1.00', '+0.50', '0', '0'])
    expect(ev(back, '10.01').results).toEqual(ev(typed, '10.01').results)
  })
  it('every round trip from a typed Adjust restores it', () => {
    const typed = typedRow()
    for (const via of [['percent'], ['exact'], ['shares'], ['equal'], ['percent', 'shares'], ['shares', 'exact', 'percent'], ['equal', 'percent', 'exact', 'shares']] as SplitMethod[][]) {
      const back = tab(via.reduce((d, m) => tab(d, m), typed), 'adjust')
      expect(back.adjust, via.join('>')).toEqual(typed.adjust)
    }
  })
  it('does not drop an invalid or half-typed Adjust either', () => {
    const half = typeInto(typeInto(open(), 'you', '+1.00'), 'maya', '99')
    expect(ev(half, '10.01').ok).toBe(false)
    const back = tab(tab(tab(half, 'percent'), 'shares'), 'adjust')
    expect(back.adjust).toEqual(half.adjust)
    expect(cell(back, 'maya')).toBe('+99')
  })
  it('keeps the sign consistent: button, minus, plus, plain digits and a leading dot', () => {
    let d = typeInto(open(), 'you', '2')
    expect(cell(d, 'you')).toBe('+2')
    d = { ...d, adjust: { ...d.adjust, you: toggleAdjustSign(d.adjust.you!) } }
    expect(cell(d, 'you')).toBe('-2')
    expect(adjustSign(d.adjust.you!)).toBe('-')
    d = typeInto(d, 'you', '3')            // typing over it keeps the minus the button set
    expect(cell(d, 'you')).toBe('-3')
    d = typeInto(d, 'maya', '-0.50')
    expect(cell(d, 'maya')).toBe('-0.50')
    d = typeInto(d, 'leo', '.5')
    expect(cell(d, 'leo')).toBe('+.5')
    expect(ev(d, '10.01').ok).toBe(true)
    expect(adjustTyped('+1.00', '++1.00')).toBe('+1.00')
    expect(adjustTyped('+1.00', '−2')).toBe('-2')
    expect(adjustTyped('+1.00', '')).toBe('')
    expect(toggleAdjustSign('')).toBe('-')
    // a sign with no digits yet is zero, not an amount error
    expect(ev({ ...open(), adjust: { ...open().adjust, you: '+', maya: '-' } }, '10.01').ok).toBe(true)
  })
  it('a typed zero in any spelling is zero, not "Enter an amount greater than 0"', () => {
    for (const zero of ['0', '0.', '0.0', '0.00', '.', '.0', '+0', '-0', '+0.00']) {
      expect(parseAmountText(zero, 'USD', true), zero).toBe(0)
    }
    expect(parseAmountText('.5', 'USD', true)).toBe(50)
    expect(parseAmountText('5.', 'USD', false)).toBe(500)
  })
  it('a change made in between (a cell, or the amount) is not rolled back', () => {
    const viaPercent = tab(typedRow(), 'percent')
    const edited = { ...viaPercent, percent: { ...viaPercent.percent, you: '40', maya: '30', leo: '20', priya: '10' } }
    const back = tab(edited, 'adjust')
    expect(back.adjust).not.toEqual(typedRow().adjust)
    expect(ev(back, '10.01').results).toEqual(ev(edited, '10.01').results)
    const newAmount = tab(viaPercent, 'adjust', '20.02')
    expect(ev(newAmount, '20.02').ok).toBe(true)
    expect(ev(newAmount, '20.02').results).toEqual(ev(viaPercent, '20.02').results)
  })
})

describe('QA chunk 2 fixes', () => {
  it('a sign typed after the digits sets the sign; the cell never holds two signs', () => {
    expect(adjustTyped('+10', '+10-')).toBe('-10')
    expect(adjustTyped('', '10-')).toBe('-10')
    expect(adjustTyped('-10', '-10+')).toBe('+10')
    expect(adjustTyped('+1', '+-1-+')).toBe('+1')
    expect(adjustDisplay(adjustTyped('+10', '+10-'))).toBe('-10')
    expect(adjustTyped('+10', '+10-').match(/[+-]/g)).toHaveLength(1)
    expect(adjustTyped('-2', '-2.555')).toBe('-2.55')
    expect(adjustTyped('+1', '+1a')).toBe('+1')
  })
  it('an amount over the API cap says the max instead of "Enter an amount"', () => {
    const e = evaluate(newDraft(ids), ids, '100000.01', 'USD', 'you')
    expect(e).toMatchObject({ ok: false, cta: 'Lower the amount', amountBad: true, bar: { tone: 'bad', left: 'Max is $100,000.00' } })
    expect(evaluate(newDraft(ids), ids, '100000', 'USD', 'you').ok).toBe(true)
    expect(evaluate(newDraft(ids), ids, '9999999999999999999999', 'USD', 'you').bar.left).toBe('Max is $100,000.00')
    expect(evaluate(newDraft(ids), ids, 'abc', 'USD', 'you').cta).toBe('Enter an amount')
    expect(evaluate(newDraft(ids), ids, '', 'USD', 'you').bar.left).not.toMatch(/Max/)
    expect(amountTooLarge('100000.01', 'USD')).toBe(true)
    expect(amountTooLarge('100,000.00', 'USD')).toBe(false)
    expect(amountTooLarge('12.345', 'USD')).toBe(false)
  })
  it('amount fields keep digits and one decimal point, at most two decimals, no sign', () => {
    expect(sanitizeAmountText('12.345')).toBe('12.34')
    expect(sanitizeAmountText('abc')).toBe('')
    expect(sanitizeAmountText('-5')).toBe('5')
    expect(sanitizeAmountText('1,5')).toBe('1.5')
    expect(sanitizeAmountText('1,')).toBe('1.')   // typing "1,5" key by key
    expect(sanitizeAmountText('1,000.50')).toBe('1000.50')
    expect(sanitizeAmountText('1,000')).toBe('1000')
    expect(sanitizeAmountText('1.2.3')).toBe('1.23')
    expect(sanitizeAmountText('.5')).toBe('.5')
    expect(sanitizeAmountText(' 7 ')).toBe('7')
    expect(sanitizeAmountText('12.5', 0)).toBe('12')
  })
})
