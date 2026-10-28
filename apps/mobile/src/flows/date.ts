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
