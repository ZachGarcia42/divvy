import { describe, expect, it } from 'vitest'
import { dateFromIso, dateLabel, dateToSave, isoFromDate, shiftIso } from './date'

describe('local calendar dates', () => {
  it('names the local day, not the UTC day', () => {
    // 23:30 and 00:30 local are on the other side of midnight UTC in most zones; toISOString() would pick the wrong day in one of them.
    expect(isoFromDate(new Date(2026, 9, 27, 23, 30))).toBe('2026-10-27')
    expect(isoFromDate(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01')
    expect(isoFromDate(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31')
  })
  it('round-trips every day of a DST-heavy stretch without drifting', () => {
    let iso = '2026-02-27'
    for (let i = 0; i < 400; i++) {
      const next = shiftIso(iso, 1)
      expect(isoFromDate(dateFromIso(next)!)).toBe(next)
      expect(shiftIso(next, -1)).toBe(iso)
      iso = next
    }
    expect(iso).toBe('2027-04-03')
  })
  it('rejects things that are not days', () => {
    expect(dateFromIso('2026-02-30')).toBeNull()
    expect(dateFromIso('')).toBeNull()
    expect(dateFromIso('26-1-1')).toBeNull()
    expect(dateFromIso('2026-13-01')).toBeNull()
    expect(dateFromIso('2028-02-29')).not.toBeNull()
  })
  it('crosses month and year ends', () => {
    expect(shiftIso('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftIso('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftIso('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('date labels', () => {
  const today = '2026-10-27'
  it('says Today and Yesterday only when they apply', () => {
    expect(dateLabel('2026-10-27', today)).toBe('Today')
    expect(dateLabel('2026-10-26', today)).toBe('Yesterday')
    expect(dateLabel('2026-10-25', today)).toBe('Sun, Oct 25')
    expect(dateLabel('2026-10-28', today)).toBe('Wed, Oct 28')
  })
  it('knows yesterday across a month and year boundary', () => {
    expect(dateLabel('2026-02-28', '2026-03-01')).toBe('Yesterday')
    expect(dateLabel('2025-12-31', '2026-01-01')).toBe('Yesterday')
  })
  it('shows the year for other years', () => {
    expect(dateLabel('2025-03-09', today)).toBe('Sun, Mar 9, 2025')
  })
})

describe('which date is saved', () => {
  const today = '2026-10-27'
  it('a new expense left on today lets the server stamp today in the group zone', () => { expect(dateToSave(today, null, today)).toBeNull() })
  it('a picked day is sent as that local calendar day', () => { expect(dateToSave('2026-10-20', null, today)).toBe('2026-10-20') })
  it('an untouched edit keeps its stored date, even if that was today', () => {
    expect(dateToSave('2026-10-05', '2026-10-05', today)).toBe('2026-10-05')
    expect(dateToSave(today, today, today)).toBe(today)
  })
  it('an edit moved to another day sends the new day', () => { expect(dateToSave('2026-10-01', '2026-10-05', today)).toBe('2026-10-01') })
  it('an edit moved to today sends today explicitly', () => { expect(dateToSave(today, '2026-10-05', today)).toBe(today) })
})
