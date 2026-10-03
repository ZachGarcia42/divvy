import { computeShares, type SplitSpec } from './allocate.ts'

export function defaultSplitSpec(
  selectedIds: string[],
  weights: Record<string, number | null | undefined>,
): SplitSpec {
  const anyDefined = selectedIds.some((id) => weights[id] != null)
  const allZeroOrMissing = selectedIds.every((id) => !weights[id])
  if (!anyDefined || allZeroOrMissing) {
    return { type: 'equal', participantIds: selectedIds }
  }
  return {
    type: 'shares',
    parts: selectedIds.map((id) => ({ participantId: id, weight: weights[id] ?? 0 })),
  }
}

/** The split a new expense starts from. Incomplete defaults (someone has no weight yet) stay equal. */
export function startingSplit(members: { id: string; weight: number | null }[]): SplitSpec {
  const ids = members.map((member) => member.id)
  if (members.length === 0 || members.some((member) => member.weight == null)) {
    return { type: 'equal', participantIds: ids }
  }
  if (members.every((member) => member.weight === 1)) {
    return { type: 'equal', participantIds: ids }
  }
  return {
    type: 'shares',
    parts: members.map((member) => ({ participantId: member.id, weight: member.weight ?? 0 })),
  }
}

export function sharesFromDefault(
  totalMinor: number,
  selectedIds: string[],
  weights: Record<string, number | null | undefined>,
): { participantId: string; minor: number }[] {
  return computeShares(totalMinor, defaultSplitSpec(selectedIds, weights))
}
