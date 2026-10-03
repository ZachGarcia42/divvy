import { allocateByWeights } from './allocate.ts'
import { LedgerError, assertMinor } from './money.ts'

export type PartyAmount = { participantId: string; minor: number }

export type LedgerExpense = {
  id: string
  deleted?: boolean
  kind: 'expense' | 'reimbursement'
  payers: PartyAmount[]
  shares: PartyAmount[]
}

export type LedgerSettlement = {
  id: string
  deleted?: boolean
  fromId: string
  toId: string
  minor: number
}

export type Edge = { fromId: string; toId: string; minor: number }

export function expenseNets(expense: LedgerExpense): Map<string, number> {
  const nets = new Map<string, number>()
  const ids = new Set([
    ...expense.payers.map((row) => row.participantId),
    ...expense.shares.map((row) => row.participantId),
  ])
  for (const id of ids) {
    const paid = expense.payers.find((row) => row.participantId === id)?.minor ?? 0
    const share = expense.shares.find((row) => row.participantId === id)?.minor ?? 0
    // A reimbursement is outside money coming back, so the signs flip.
    const net = expense.kind === 'reimbursement' ? share - paid : paid - share
    if (net !== 0) nets.set(id, net)
  }
  return nets
}

export function participantNets(
  expenses: LedgerExpense[],
  settlements: LedgerSettlement[],
): Map<string, number> {
  const nets = new Map<string, number>()
  const add = (id: string, delta: number) => {
    nets.set(id, (nets.get(id) ?? 0) + delta)
  }
  for (const expense of expenses) {
    if (expense.deleted) continue
    for (const [id, net] of expenseNets(expense)) add(id, net)
  }
  for (const settlement of settlements) {
    if (settlement.deleted) continue
    assertMinor(settlement.minor, 'Settlement')
    if (settlement.minor <= 0) {
      throw new LedgerError('BAD_AMOUNT', 'A settlement must be a positive amount')
    }
    if (settlement.fromId === settlement.toId) {
      throw new LedgerError('BAD_SETTLEMENT', 'A settlement needs two different people')
    }
    add(settlement.fromId, settlement.minor)
    add(settlement.toId, -settlement.minor)
  }
  for (const [id, net] of nets) {
    if (net === 0) nets.delete(id)
  }
  return nets
}

/** Direct reading of one expense: shortfalls are owed to the people who overpaid, in proportion. */
export function pairwiseFromNets(nets: Map<string, number>): Edge[] {
  const creditors = [...nets.entries()].filter(([, net]) => net > 0)
  const debtors = [...nets.entries()].filter(([, net]) => net < 0)
  const edges: Edge[] = []
  const weights = creditors.map(([id, net]) => ({ id, weight: net }))
  for (const [debtorId, net] of debtors) {
    const parts = allocateByWeights(-net, weights)
    for (const part of parts) {
      if (part.minor > 0) edges.push({ fromId: debtorId, toId: part.id, minor: part.minor })
    }
  }
  return edges
}

export function directEdges(expenses: LedgerExpense[], settlements: LedgerSettlement[]): Edge[] {
  const signed = new Map<string, number>()
  const addDebt = (fromId: string, toId: string, minor: number) => {
    if (fromId === toId || minor === 0) return
    const forward = fromId < toId
    const low = forward ? fromId : toId
    const high = forward ? toId : fromId
    const key = `${low}|${high}`
    const delta = forward ? minor : -minor
    signed.set(key, (signed.get(key) ?? 0) + delta)
  }
  for (const expense of expenses) {
    if (expense.deleted) continue
    for (const edge of pairwiseFromNets(expenseNets(expense))) {
      addDebt(edge.fromId, edge.toId, edge.minor)
    }
  }
  for (const settlement of settlements) {
    if (settlement.deleted) continue
    addDebt(settlement.fromId, settlement.toId, -settlement.minor)
  }
  const edges: Edge[] = []
  for (const [key, minor] of signed) {
    if (minor === 0) continue
    const [low, high] = key.split('|')
    if (minor > 0) edges.push({ fromId: low!, toId: high!, minor })
    else edges.push({ fromId: high!, toId: low!, minor: -minor })
  }
  edges.sort((a, b) => a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId))
  return edges
}

export function simplifyNets(nets: Map<string, number>): Edge[] {
  let sum = 0
  for (const net of nets.values()) sum += net
  if (sum !== 0) {
    throw new LedgerError('UNBALANCED', 'Balances do not add up to zero')
  }
  const debtors = [...nets.entries()]
    .filter(([, net]) => net < 0)
    .map(([id, net]) => ({ id, left: -net }))
  const creditors = [...nets.entries()]
    .filter(([, net]) => net > 0)
    .map(([id, net]) => ({ id, left: net }))
  const edges: Edge[] = []
  while (debtors.some((row) => row.left > 0) && creditors.some((row) => row.left > 0)) {
    debtors.sort((a, b) => b.left - a.left || a.id.localeCompare(b.id))
    creditors.sort((a, b) => b.left - a.left || a.id.localeCompare(b.id))
    const debtor = debtors[0]!
    const creditor = creditors[0]!
    const pay = Math.min(debtor.left, creditor.left)
    edges.push({ fromId: debtor.id, toId: creditor.id, minor: pay })
    debtor.left -= pay
    creditor.left -= pay
  }
  return edges
}

export function suggestedPayments(
  expenses: LedgerExpense[],
  settlements: LedgerSettlement[],
  simplify: boolean,
): Edge[] {
  if (!simplify) return directEdges(expenses, settlements)
  return simplifyNets(participantNets(expenses, settlements))
}

export function paymentBetween(edges: Edge[], a: string, b: string): Edge | null {
  return edges.find((edge) =>
    (edge.fromId === a && edge.toId === b) || (edge.fromId === b && edge.toId === a),
  ) ?? null
}

export function canRemove(net: number): boolean {
  return net === 0
}

export function canMove(input: {
  actorInSource: boolean
  actorInDestination: boolean
  participantIds: string[]
  destinationMemberIds: string[]
}): boolean {
  if (!input.actorInSource || !input.actorInDestination) return false
  const members = new Set(input.destinationMemberIds)
  return input.participantIds.every((id) => members.has(id))
}

export function checkVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new LedgerError('STALE', 'Someone else changed this. Reload it and try again.')
  }
}
