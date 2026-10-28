import { describe, expect, it } from 'vitest'
import { SNACK_MS, snackOwner, snackStays, breakdown, dateHeading, groupByDate, historyLines, methodPhrase, netTone, overallUsd, paidPhrase, signedMoney, groupIcon, PICKER_EMOJIS, splitGroupName, startScreen, updatedPhrase, yourPosition } from './view'

const g = (id: string, net: number, extra: object = {}) => ({ id, name: id, currency: 'USD', yourNetMinor: net, archived: false, ...extra })

describe('groups home', () => {
  it('sums the overall USD net with owed and owe broken out', () => {
    const o = overallUsd([g('a', 9625), g('b', -4250), g('c', 3250), g('d', 0)])
    expect(o).toMatchObject({ net: 8625, owed: 12875, owe: 4250, groupCount: 4, leftOut: 0 })
    expect(signedMoney(o.net)).toBe('+$86.25')
    expect(signedMoney(-5)).toBe('-$0.05')
    expect(signedMoney(0)).toBe('$0.00')
  })
  it('is USD only: other currencies are left out and flagged, archived groups do not count', () => {
    const o = overallUsd([g('a', 1000), g('b', 99999, { currency: 'EUR' }), g('c', -500, { archived: true })])
    expect(o).toMatchObject({ net: 1000, owed: 1000, owe: 0, groupCount: 2, usdCount: 1, leftOut: 1 })
  })
  it('labels each group row', () => {
    expect([netTone(1), netTone(-1), netTone(0)]).toEqual(['owed', 'owe', 'settled'])
  })
  it('keeps the icon as a leading emoji in the name', () => {
    expect(splitGroupName('🏔️ Tahoe cabin weekend')).toEqual({ emoji: '🏔️', title: 'Tahoe cabin weekend' })
    expect(splitGroupName('Mission St apartment')).toEqual({ emoji: '👥', title: 'Mission St apartment' })
    expect(splitGroupName('👨‍👩‍👧 Family')).toEqual({ emoji: '👨‍👩‍👧', title: 'Family' })
    expect(splitGroupName('2025 trip')).toEqual({ emoji: '👥', title: '2025 trip' })
  })
  it('says when a group was last touched', () => {
    expect(updatedPhrase('2026-10-27', '2026-10-27')).toBe('updated today')
    expect(updatedPhrase('2026-10-26', '2026-10-27')).toBe('yesterday')
    expect(updatedPhrase('2026-10-22', '2026-10-27')).toBe('Oct 22')
    expect(updatedPhrase(null, '2026-10-27')).toBe('no expenses yet')
  })
})

describe('group screen rows', () => {
  const payers = (id: string, name: string, minor: number) => [{ participantId: id, name, minor }]
  const groceries = { id: 'e1', date: '2026-10-27', description: 'Groceries', settlementMinor: 12000, splitMethod: 'shares', payers: payers('you', 'You', 12000), shares: [{ participantId: 'you', minor: 4000 }, { participantId: 'maya', minor: 2000 }, { participantId: 'leo', minor: 2000 }, { participantId: 'priya', minor: 4000 }] }
  const gas = { id: 'e2', date: '2026-10-27', description: 'Gas, drive up', settlementMinor: 6400, splitMethod: 'equal', payers: payers('maya', 'Maya', 6400), shares: [{ participantId: 'you', minor: 1600 }, { participantId: 'maya', minor: 1600 }, { participantId: 'leo', minor: 1600 }, { participantId: 'priya', minor: 1600 }] }
  it('shows what you lent or borrowed', () => {
    expect(yourPosition(groceries, 'you')).toEqual({ kind: 'lent', minor: 8000 })
    expect(yourPosition(gas, 'you')).toEqual({ kind: 'borrowed', minor: 1600 })
    expect(yourPosition(gas, 'zed')).toEqual({ kind: 'none', minor: 0 })
    expect(paidPhrase(groceries, 'you', 'USD')).toBe('You paid $120.00')
    expect(paidPhrase(gas, 'you', 'USD')).toBe('Maya paid $64.00')
    expect(methodPhrase('shares')).toBe('shares')
    expect(methodPhrase('equal')).toBe('split equally')
    expect(methodPhrase(undefined)).toBe('custom split')
  })
  it('groups by date, newest first', () => {
    const older = { ...gas, id: 'e0', date: '2026-10-24' }
    const out = groupByDate([older, gas, groceries], '2026-10-27')
    expect(out.map((d) => d.heading)).toEqual(['TODAY · OCT 27', 'SAT · OCT 24'])
    expect(out[0]!.items.map((e) => e.id)).toEqual(['e2', 'e1'])
    expect(dateHeading('2026-10-26', '2026-10-27')).toBe('YESTERDAY · OCT 26')
  })
  it('sorts same-day expenses by created time, then id', () => {
    const at = (id: string, createdAt: string | null) => ({ ...gas, id, createdAt })
    const out = groupByDate([at('a', '2026-10-27T09:00:00.000Z'), at('z', '2026-10-27T08:00:00.000Z'), at('m', '2026-10-27T09:00:00.000Z'), at('b', '2026-10-27T10:30:00.000Z')], '2026-10-27')
    // newest created first; equal times fall back to the larger id first
    expect(out[0]!.items.map((e) => e.id)).toEqual(['b', 'm', 'a', 'z'])
    // an older day never jumps ahead because it was created later
    const later = { ...gas, id: 'old', date: '2026-10-20', createdAt: '2026-10-27T23:00:00.000Z' }
    expect(groupByDate([later, at('a', '2026-10-27T09:00:00.000Z')], '2026-10-27').map((d) => d.items[0]!.id)).toEqual(['a', 'old'])
  })
  it('builds the detail breakdown', () => {
    const rows = breakdown(groceries, (id) => id, 'shares', { parts: [{ participantId: 'you', weight: 2 }, { participantId: 'maya', weight: 1 }, { participantId: 'leo', weight: 1 }, { participantId: 'priya', weight: 2 }] })
    expect(rows[0]).toEqual({ id: 'you', name: 'you', paid: 12000, share: 4000, net: 8000, note: '2 shares of 6' })
    expect(rows[1]).toMatchObject({ net: -2000, note: '1 share of 6' })
    expect(rows.reduce((a, r) => a + r.net, 0)).toBe(0)
    const pct = breakdown(gas, (id) => id, 'percent', { parts: [{ participantId: 'maya', bps: 2550 }] })
    expect(pct.find((r) => r.id === 'maya')!.note).toBe('25.5%')
  })
})

describe('history lines', () => {
  const name = (id: string) => ({ you: 'You', maya: 'Maya' } as Record<string, string>)[id] ?? id
  it('says who changed what', () => {
    const lines = historyLines([
      { id: '1', kind: 'created', actorId: 'you', actorName: 'Zach', changes: null, at: 'a' },
      { id: '2', kind: 'edited', actorId: 'maya', actorName: 'Maya', changes: [{ field: 'method', from: 'equal', to: 'shares' }, { field: 'split', from: {}, to: {} }], at: 'b' },
      { id: '3', kind: 'edited', actorId: 'you', actorName: 'Zach', changes: [{ field: 'amount', from: 1, to: 2500 }, { field: 'description', from: '', to: 'Gas' }], at: 'c' },
      { id: '4', kind: 'edited', actorId: 'you', actorName: 'Zach', changes: null, at: 'd' },
      { id: '5', kind: 'deleted', actorId: null, actorName: null, changes: null, at: 'e' },
    ], 'you', 'USD', name, (iso) => `@${iso}`)
    expect(lines.map((l) => l.text)).toEqual([
      'You added this',
      'Maya changed the split to shares',
      'You changed the amount to $25.00 and the description to “Gas”',
      'You edited this',
      'Someone deleted this',
    ])
    expect(lines[0]!.time).toBe('@a')
  })
})

describe('opening the app', () => {
  it('reopens the last group, else shows Groups', () => {
    const groups = [{ id: 'a' }, { id: 'b', archived: true }]
    expect(startScreen(groups, 'a')).toEqual({ screen: 'group', groupId: 'a' })
    expect(startScreen(groups, 'b')).toEqual({ screen: 'groups', groupId: null })
    expect(startScreen(groups, 'gone')).toEqual({ screen: 'groups', groupId: null })
    expect(startScreen(groups, null)).toEqual({ screen: 'groups', groupId: null })
    expect(startScreen([], 'a').screen).toBe('groups')
  })

  it('groupIcon prefers the stored emoji and falls back to a leading emoji, then the default', () => {
    expect(groupIcon({ name: 'Trip', emoji: '🏔️' })).toEqual({ emoji: '🏔️', title: 'Trip' })
    expect(groupIcon({ name: '🏠 Home', emoji: '🐶' })).toEqual({ emoji: '🐶', title: 'Home' })
    expect(groupIcon({ name: '🏠 Home', emoji: null })).toEqual({ emoji: '🏠', title: 'Home' })
    expect(groupIcon({ name: 'Plain' })).toEqual({ emoji: '👥', title: 'Plain' })
  })
})

describe('undo snackbar lifetime', () => {
  it('lasts six seconds and belongs to the screen it was raised on', () => {
    expect(SNACK_MS).toBe(6000)
    const owner = snackOwner('group', 'g1')
    expect(snackStays(owner, 'group', 'g1')).toBe(true)
    expect(snackStays(owner, 'settle', 'g1')).toBe(false)
    expect(snackStays(owner, 'group', 'g2')).toBe(false)
    expect(snackStays(undefined, 'group', 'g1')).toBe(false)
  })
})
