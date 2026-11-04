// Expense dates are calendar days ("YYYY-MM-DD") in the person's local time. Never go through toISOString() here: that is
// UTC, so late in the evening (or early in the morning east of Greenwich) it names the wrong day.

const pad = (n: number) => String(n).padStart(2, '0')

/** The local calendar day of a Date. */
export function isoFromDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A Date for a calendar day, at local noon so a DST shift can never move it to another day. null if it is not a real day. */
export function dateFromIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d, 12)
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null
}

export function shiftIso(iso: string, days: number): string {
  const date = dateFromIso(iso)
  if (!date) return iso
  date.setDate(date.getDate() + days)
  return isoFromDate(date)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Today", "Yesterday", otherwise "Mon, Oct 26" (with the year when it is not this year). */
export function dateLabel(iso: string, today: string): string {
  if (iso === today) return 'Today'
  if (iso === shiftIso(today, -1)) return 'Yesterday'
  const date = dateFromIso(iso)
  if (!date) return iso
  const base = `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`
  return iso.slice(0, 4) === today.slice(0, 4) ? base : `${base}, ${date.getFullYear()}`
}

/**
 * What to send as the expense date. `null` lets the server use today in the group's own time zone (the default for a new
 * expense). An edit that was not touched keeps its stored date; a picked day is sent as that local calendar day.
 */
export function dateToSave(picked: string, original: string | null, today: string): string | null {
  if (original && picked === original) return original
  if (!original && picked === today) return null
  return picked
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "October 2026". `month` is 0 to 11. */
export function monthTitle(year: number, month: number): string {
  return `${MONTH_NAMES[((month % 12) + 12) % 12]} ${year}`
}

/** The month `by` months from this one (negative goes back), as a year and a 0 to 11 month. */
export function shiftMonth(year: number, month: number, by: number): { year: number; month: number } {
  const index = year * 12 + month + by
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 }
}

/** A month as a calendar grid, Sunday first: every day as "YYYY-MM-DD", `null` for the blanks before the 1st and after the last day, in whole weeks. */
export function monthGrid(year: number, month: number): (string | null)[] {
  const first = new Date(year, month, 1, 12)
  const days = new Date(year, month + 1, 0, 12).getDate()
  const cells: (string | null)[] = Array.from({ length: first.getDay() }, () => null)
  for (let day = 1; day <= days; day++) cells.push(isoFromDate(new Date(year, month, day, 12)))
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

const KEY_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

/** Calendar keyboard: the day an arrow key (or Home / End of the week) moves to from `iso`, never past `today`. null for other keys. */
export function dayForKey(iso: string, key: string, today: string): string | null {
  const date = dateFromIso(iso)
  if (!date) return null
  let next: string
  if (key in KEY_STEP) next = shiftIso(iso, KEY_STEP[key])
  else if (key === 'Home') next = shiftIso(iso, -date.getDay())
  else if (key === 'End') next = shiftIso(iso, 6 - date.getDay())
  else return null
  return next > today ? today : next
}
