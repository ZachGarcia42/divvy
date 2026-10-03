import { formatMoney } from '@divvy/domain'

type Payment = { fromId: string; toId: string; minor: number }

const WIDTH = 640

export function DebtFlow({
  payments,
  names,
  currency,
  simplified,
}: {
  payments: Payment[]
  names: Map<string, string>
  currency: string
  simplified: boolean
}) {
  if (payments.length === 0) {
    return (
      <section className="chart-card">
        <h2>Debt flow</h2>
        <p className="muted">This group is settled, so there is nothing to draw.</p>
      </section>
    )
  }
  const fromIds = unique(payments.map((payment) => payment.fromId))
  const toIds = unique(payments.map((payment) => payment.toId))
  const middle = fromIds.filter((id) => toIds.includes(id))
  const columns = [
    fromIds.filter((id) => !middle.includes(id)),
    middle,
    toIds.filter((id) => !middle.includes(id)),
  ].filter((column) => column.length > 0)
  const rows = Math.max(1, ...columns.map((column) => column.length))
  const height = rows * 92 + 28
  const nodes = new Map<string, { x: number; y: number; role: 'from' | 'to' | 'both' }>()
  columns.forEach((column, columnIndex) => {
    const x = columns.length === 1 ? WIDTH / 2 : 78 + ((WIDTH - 156) * columnIndex) / (columns.length - 1)
    const role = columnIndex === 0 ? 'from' : columnIndex === columns.length - 1 ? 'to' : 'both'
    column.forEach((id, index) => {
      const y = ((index + 1) * height) / (column.length + 1)
      nodes.set(id, { x, y, role: role as 'from' | 'to' | 'both' })
    })
  })
  const summary = payments
    .map((payment) => `${names.get(payment.fromId) ?? 'Someone'} pays ${names.get(payment.toId) ?? 'someone'} ${formatMoney(payment.minor, currency)}`)
    .join('. ')

  return (
    <section className="chart-card">
      <h2>Debt flow</h2>
      <p className="muted">{simplified ? 'Simplified payments. Each person is only on one side.' : 'Direct debts, before they are simplified.'} An arrow is a balance to record. It does not move money.</p>
      <svg className="debt-flow" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={summary}>
        <defs>
          <marker id="debt-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--debt-arrow)" />
          </marker>
        </defs>
        {payments.map((payment) => {
          const from = nodes.get(payment.fromId)
          const to = nodes.get(payment.toId)
          if (!from || !to) return null
          const siblings = payments
            .filter((item) => item.toId === payment.toId)
            .slice()
            .sort((a, b) => (nodes.get(a.fromId)?.y ?? 0) - (nodes.get(b.fromId)?.y ?? 0))
          const index = siblings.findIndex((item) => item.fromId === payment.fromId)
          const spread = (index - (siblings.length - 1) / 2) * 18
          const path = edgePath(from, to, spread)
          const label = formatMoney(payment.minor, currency)
          return (
            <g key={`${payment.fromId}-${payment.toId}`}>
              <path d={path.d} fill="none" stroke="var(--debt-arrow)" strokeWidth="2.5" markerEnd="url(#debt-arrow)" />
              <rect x={path.labelX - 42} y={path.labelY - 11} width="84" height="22" rx="11" fill="var(--card)" stroke="var(--line)" />
              <text x={path.labelX} y={path.labelY + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--ink)">{label}</text>
            </g>
          )
        })}
        {[...nodes.entries()].map(([id, node]) => (
          <g key={id}>
            <circle cx={node.x} cy={node.y} r="24" fill={node.role === 'to' ? 'var(--debt-to)' : node.role === 'from' ? 'var(--debt-from)' : 'var(--debt-both)'} stroke={node.role === 'to' ? 'var(--good)' : node.role === 'from' ? 'var(--bad)' : 'var(--accent)'} strokeWidth="2" />
            <text x={node.x} y={node.y + 5} textAnchor="middle" fontSize="14" fontWeight="800" fill="var(--ink)">{initials(names.get(id) ?? '?')}</text>
            <text x={node.x} y={node.y + 44} textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--muted)">{names.get(id) ?? 'Someone'}</text>
          </g>
        ))}
      </svg>
    </section>
  )
}

function unique(ids: string[]) {
  return [...new Set(ids)]
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?'
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, endOffset: number) {
  const sameColumn = Math.abs(from.x - to.x) < 8
  const startX = sameColumn ? from.x + 26 : from.x + Math.sign(to.x - from.x) * 28
  const endX = sameColumn ? to.x + 26 : to.x - Math.sign(to.x - from.x) * 34
  const endY = to.y + endOffset
  const bend = sameColumn ? 90 : 0
  const c1x = startX + (endX - startX) * 0.55 + bend
  const c2x = endX - (endX - startX) * 0.25 + bend
  const labelX = 0.125 * startX + 0.375 * c1x + 0.375 * c2x + 0.125 * endX
  return {
    d: `M ${startX} ${from.y} C ${c1x} ${from.y}, ${c2x} ${endY}, ${endX} ${endY}`,
    labelX,
    labelY: from.y * 0.45 + endY * 0.55,
  }
}
