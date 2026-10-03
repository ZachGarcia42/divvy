import { FIXED_CATEGORIES, formatMoney } from '@divvy/domain'
import { useId, useState } from 'react'

export type ChartEntry = {
  month: string
  categoryId: string
  shareMinor: number
  paidMinor: number
  label?: string
}

export type ChartResponse = {
  currency: string
  categories?: { categoryId: string; label?: string; shareMinor: number; paidMinor?: number }[]
  entries?: ChartEntry[]
}

const COLORS: Record<string, string> = {
  cat_rent: '#4f46e5',
  cat_groceries: '#10b981',
  cat_dining: '#f59e0b',
  cat_transport: '#0ea5e9',
  cat_travel: '#ec4899',
  cat_utilities: '#8b5cf6',
  cat_entertainment: '#f97316',
  cat_general: '#64748b',
}

const FALLBACK = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#f97316', '#ec4899', '#8b5cf6', '#14b8a6']

export function categoryColor(categoryId: string) {
  const known = COLORS[categoryId]
  if (known) return known
  let hash = 0
  for (const char of categoryId) hash = (hash * 33 + char.charCodeAt(0)) >>> 0
  return FALLBACK[hash % FALLBACK.length] ?? '#4f46e5'
}

export function categoryName(categoryId: string, label?: string) {
  if (label && label !== categoryId) return label
  return FIXED_CATEGORIES.find((category) => category.id === categoryId)?.label ?? label ?? 'Other'
}

export function entriesOf(body: ChartResponse, today: string): ChartEntry[] {
  if (body.entries && body.entries.length > 0) return body.entries
  const month = today.slice(0, 7)
  return (body.categories ?? []).map((row) => ({
    month,
    categoryId: row.categoryId,
    label: row.label,
    shareMinor: row.shareMinor,
    paidMinor: row.paidMinor ?? 0,
  }))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthName(month: string, withYear: boolean) {
  const [year, index] = month.split('-')
  const name = MONTHS[Number(index) - 1] ?? month
  return withYear ? `${name} ${year?.slice(2) ?? ''}` : name
}

function nextMonth(month: string) {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const index = Number(monthText)
  if (index === 12) return `${year + 1}-01`
  return `${year}-${String(index + 1).padStart(2, '0')}`
}

type Row = { categoryId: string; label: string; shareMinor: number; paidMinor: number }

function rowsFrom(entries: ChartEntry[]): Row[] {
  const totals = new Map<string, Row>()
  for (const entry of entries) {
    const row = totals.get(entry.categoryId) ?? {
      categoryId: entry.categoryId,
      label: categoryName(entry.categoryId, entry.label),
      shareMinor: 0,
      paidMinor: 0,
    }
    row.shareMinor += entry.shareMinor
    row.paidMinor += entry.paidMinor
    if (entry.label) row.label = categoryName(entry.categoryId, entry.label)
    totals.set(entry.categoryId, row)
  }
  return [...totals.values()]
    .filter((row) => row.shareMinor !== 0 || row.paidMinor !== 0)
    .sort((a, b) => b.shareMinor - a.shareMinor || a.label.localeCompare(b.label))
}

function monthSeries(entries: ChartEntry[], today: string) {
  const byCategory = new Map<string, Map<string, number>>()
  for (const entry of entries) {
    if (entry.shareMinor <= 0) continue
    const categories = byCategory.get(entry.month) ?? new Map<string, number>()
    categories.set(entry.categoryId, (categories.get(entry.categoryId) ?? 0) + entry.shareMinor)
    byCategory.set(entry.month, categories)
  }
  const end = today.slice(0, 7)
  const earliest = [...byCategory.keys()].sort()[0] ?? end
  let start = earliest === end ? `${end.slice(0, 4)}-01` : earliest
  if (start > end) start = `${end.slice(0, 4)}-01`
  const months: { month: string; total: number; parts: { categoryId: string; shareMinor: number }[] }[] = []
  for (let cursor = start; cursor <= end && months.length < 18; cursor = nextMonth(cursor)) {
    const parts = [...(byCategory.get(cursor)?.entries() ?? [])]
      .map(([categoryId, shareMinor]) => ({ categoryId, shareMinor }))
      .sort((a, b) => b.shareMinor - a.shareMinor)
    months.push({ month: cursor, total: parts.reduce((sum, part) => sum + part.shareMinor, 0), parts })
  }
  return months
}

function percentLabel(part: number, total: number) {
  if (total <= 0 || part <= 0) return '0%'
  const value = (part / total) * 100
  return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`
}

export function SpendingChart({
  currency,
  entries,
  today,
  scope,
  note,
}: {
  currency: string
  entries: ChartEntry[]
  today: string
  scope: string
  note?: string
}) {
  const titleId = useId()
  const monthKey = today.slice(0, 7)
  const monthEntries = entries.filter((entry) => entry.month === monthKey)
  const [range, setRange] = useState<'month' | 'all'>(monthEntries.some((entry) => entry.shareMinor !== 0) ? 'month' : 'all')
  const rows = rowsFrom(range === 'month' ? monthEntries : entries)
  const positive = rows.filter((row) => row.shareMinor > 0)
  const positiveTotal = positive.reduce((sum, row) => sum + row.shareMinor, 0)
  const shareTotal = rows.reduce((sum, row) => sum + row.shareMinor, 0)
  const series = monthSeries(entries, today)
  const maxMonth = Math.max(1, ...series.map((month) => month.total))
  const spansYears = new Set(series.map((month) => month.month.slice(0, 4))).size > 1

  return (
    <section className="chart-card" aria-labelledby={titleId}>
      <div className="row chart-head">
        <div>
          <h2 id={titleId}>Spending</h2>
          <p className="muted">{range === 'month' ? 'Your share this month' : 'Your share, all time'} · {scope}</p>
        </div>
        <div className="pills" role="group" aria-label="Chart range">
          <button type="button" className={range === 'month' ? 'pill on' : 'pill'} onClick={() => setRange('month')}>This month</button>
          <button type="button" className={range === 'all' ? 'pill on' : 'pill'} onClick={() => setRange('all')}>All time</button>
        </div>
      </div>
      <div className="chart-layout">
        <div className="donut-wrap">
          <Donut slices={positive.map((row) => ({ id: row.categoryId, value: row.shareMinor, color: categoryColor(row.categoryId) }))} />
          <div className="donut-center">
            <strong>{formatMoney(shareTotal, currency)}</strong>
            <span>your share</span>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="muted">Nothing in this range yet. Add an expense and the categories show up here.</p>
        ) : (
          <ul className="legend">
            {rows.map((row) => {
              const width = positiveTotal <= 0 || row.shareMinor <= 0 ? 0 : Math.max(6, (row.shareMinor / positiveTotal) * 100)
              return (
                <li key={row.categoryId}>
                  <span className="swatch" style={{ background: categoryColor(row.categoryId) }} />
                  <div>
                    <div className="row">
                      <span className="legend-name">{row.label}</span>
                      <span className="money">{formatMoney(row.shareMinor, currency)}</span>
                    </div>
                    <div className="bar" aria-hidden="true"><span style={{ width: `${Math.min(100, width)}%`, background: categoryColor(row.categoryId) }} /></div>
                    <p className="tiny muted">{percentLabel(row.shareMinor, positiveTotal)} of your share{row.paidMinor !== 0 ? ` · you paid ${formatMoney(row.paidMinor, currency)}` : ''}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="over-time">
        <div className="row">
          <h3>Over time</h3>
          <span className="muted">{formatMoney(series.reduce((sum, month) => sum + month.total, 0), currency)} share</span>
        </div>
        <div className="month-chart" role="img" aria-label="Spending by month">
          {series.map((month) => {
            const height = month.total > 0 ? Math.max(10, Math.round((month.total / maxMonth) * 96)) : 0
            return (
              <div className="month-col" key={month.month}>
                <div className="month-track" title={`${monthName(month.month, true)} ${formatMoney(month.total, currency)}`}>
                  {height > 0 && (
                    <div className="month-stack" style={{ height }}>
                      {month.parts.map((part) => (
                        <span key={part.categoryId} style={{ flex: part.shareMinor, background: categoryColor(part.categoryId) }} />
                      ))}
                    </div>
                  )}
                </div>
                <span>{monthName(month.month, spansYears)}</span>
              </div>
            )
          })}
        </div>
      </div>
      {note && <p className="tiny muted chart-note">{note}</p>}
    </section>
  )
}

function Donut({ slices }: { slices: { id: string; value: number; color: string }[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const radius = 68
  const circumference = 2 * Math.PI * radius
  const gap = slices.length > 1 ? Math.min(6, circumference / slices.length / 5) : 0
  let consumed = 0
  return (
    <svg className="donut" viewBox="0 0 200 200" aria-hidden="true">
      <circle cx="100" cy="100" r={radius} fill="none" stroke="var(--donut-track)" strokeWidth="28" />
      {total > 0 && slices.map((slice) => {
        const portion = (slice.value / total) * circumference
        const length = Math.max(0, portion - gap)
        const offset = consumed
        consumed += portion
        return (
          <circle
            key={slice.id}
            cx="100"
            cy="100"
            r={radius}
            fill="none"
            stroke={slice.color}
            strokeWidth="28"
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 100 100)"
          />
        )
      })}
    </svg>
  )
}
