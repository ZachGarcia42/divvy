import { codeOf, isNetwork } from './errors'

export type PublicPreview = { groupName: string; inviterName: string | null; status: 'valid' | 'expired' | 'used' | 'archived' }
export type DeadReason = 'expired' | 'used' | 'archived' | 'missing' | 'wrong-email'

export type JoinView =
  | { kind: 'loading' }
  | { kind: 'preview'; groupId: string; groupName: string; members: { id: string; name: string }[]; joining: boolean; error: string | null }
  | { kind: 'dead'; reason: DeadReason }
  | { kind: 'already'; groupId: string; groupName: string }
  | { kind: 'offline' }

export const DEAD_TITLE = 'This link doesn’t work anymore'

export function deadCopy(reason: DeadReason) {
  switch (reason) {
    case 'expired': return 'It may have expired. Group links last 14 days. Ask someone in the group to send a new one.'
    case 'used': return 'This invite has already been used. Ask someone in the group to send a new one.'
    case 'archived': return 'This group was archived, so it isn’t taking new members.'
    case 'wrong-email': return 'This invite was sent to a different email. Sign in with that email, or ask for a group link.'
    default: return 'We couldn’t find this group link. Ask someone in the group to send a new one.'
  }
}

export function parsePublicPreview(value: unknown): PublicPreview | null {
  if (!value || typeof value !== 'object') return null
  const { groupName, inviterName, status } = value as Record<string, unknown>
  if (typeof groupName !== 'string') return null
  if (inviterName !== null && typeof inviterName !== 'string') return null
  if (status !== 'valid' && status !== 'expired' && status !== 'used' && status !== 'archived') return null
  return { groupName, inviterName: inviterName as string | null, status }
}

/** Dead reason for a failed preview/accept, or null if it is a network problem / something retryable. */
export function deadReasonFromError(reason: unknown): DeadReason | null {
  const code = codeOf(reason)
  if (code === 'ARCHIVED') return 'archived'
  if (code === 'BAD_TOKEN' || code === 'NOT_FOUND') return 'missing'
  if (code === 'FORBIDDEN') return 'wrong-email'
  return null
}

/**
 * Decide what the join card shows from the public status, the signed-in preview, and which groups
 * you're already in. Public status wins (it can tell expired/used/archived apart); membership beats Join.
 */
export function decideJoin(input: {
  publicPreview: PublicPreview | 'missing' | null
  authed: { group: { id: string; name: string }; members: { id: string; name: string }[] } | null
  yourGroupIds: string[]
  yourParticipantId?: string | null
}): JoinView {
  const { publicPreview, authed, yourGroupIds } = input
  if (publicPreview === 'missing') return { kind: 'dead', reason: 'missing' }
  if (publicPreview && publicPreview.status !== 'valid') {
    // Already a member of an archived group still just opens it.
    if (authed && yourGroupIds.includes(authed.group.id)) return { kind: 'already', groupId: authed.group.id, groupName: authed.group.name }
    return { kind: 'dead', reason: publicPreview.status }
  }
  if (!authed) return { kind: 'loading' }
  const member = yourGroupIds.includes(authed.group.id)
    || (!!input.yourParticipantId && authed.members.some((m) => m.id === input.yourParticipantId))
  if (member) return { kind: 'already', groupId: authed.group.id, groupName: authed.group.name }
  return { kind: 'preview', groupId: authed.group.id, groupName: authed.group.name, members: authed.members, joining: false, error: null }
}

/** What a failed Join does: go dead for a dead link, otherwise keep the card with inline copy. */
export function joinFailure(reason: unknown): { dead: DeadReason } | { error: string } {
  const dead = deadReasonFromError(reason)
  if (dead) return { dead }
  if (isNetwork(reason) || !codeOf(reason)) return { error: 'Couldn’t join. Check your signal and try again.' }
  return { error: reason instanceof Error ? reason.message : 'Couldn’t join.' }
}

/** Already a member if the group you just joined was in your list before you tapped Join. */
export function joinedWasAlreadyMember(joinedGroupId: string, groupIdsBefore: string[]) {
  return groupIdsBefore.includes(joinedGroupId)
}
