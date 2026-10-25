import { describe, expect, it } from 'vitest'
import { joinedFeedback, liveShareGap, middleEllipsis, parseShare, pickGroup } from './composer'

describe('composer live share gap', () => {
  const ids = ['a', 'b', 'c']
  it('recomputes from the current text on every change, in dollars not cents', () => {
    expect(liveShareGap('10', { a: '3' }, ids, 'USD')).toContain('$7.00 left')
    expect(liveShareGap('10', { a: '3', b: '3' }, ids, 'USD')).toContain('$4.00 left')
    expect(liveShareGap('10', { a: '3', b: '3', c: '4' }, ids, 'USD')).toBeNull()
    expect(liveShareGap('10', { a: '3', b: '3', c: '40' }, ids, 'USD')).toContain('$36.00 over')
    expect(liveShareGap('1,000', { a: '1000.5' }, ids, 'USD')).toContain('$0.50 over')
  })
  it('treats blank as 0 and skips the line while the amount or a share is unparseable', () => {
    expect(liveShareGap('10', {}, ids, 'USD')).toContain('$10.00 left')
    expect(liveShareGap('', { a: '3' }, ids, 'USD')).toBeNull()
    expect(liveShareGap('10', { a: 'abc' }, ids, 'USD')).toBeNull()
    expect(parseShare('  ', 'USD')).toBe(0)
    expect(parseShare('3', 'USD')).toBe(300)
  })
})

describe('group card helpers', () => {
  it('truncates long links in the middle', () => {
    const url = 'https://divvy.mooo.com/invite/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    const short = middleEllipsis(url, 36)
    expect(short).toHaveLength(36)
    expect(short.startsWith('https://divvy')).toBe(true)
    expect(short.endsWith('456789')).toBe(true)
    expect(short).toContain('…')
    expect(middleEllipsis('short', 36)).toBe('short')
  })
  it('opens the last group, else the first open one, after sign-in', () => {
    const groups = [{ id: 'old', archived: true }, { id: 'g1' }, { id: 'g2' }]
    expect(pickGroup(groups, null, null)).toBe('g1')
    expect(pickGroup(groups, null, 'g2')).toBe('g2')
    expect(pickGroup(groups, null, 'gone')).toBe('g1')
    expect(pickGroup(groups, 'g2', 'g1')).toBe('g2')
    expect(pickGroup([], null, 'g1')).toBeNull()
  })
})

describe('joining a group', () => {
  it('shows a lasting "You’re in" banner to a new member only', () => {
    expect(joinedFeedback('Ski trip', false)).toEqual({ toast: 'You’re in Ski trip', banner: 'You’re in Ski trip' })
    expect(joinedFeedback('Ski trip', true)).toEqual({ toast: 'You’re already in Ski trip.', banner: null })
  })
})
