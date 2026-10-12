import { describe, expect, it } from 'vitest'
import { decideJoin, deadCopy, deadReasonFromError, joinFailure, joinedWasAlreadyMember, parsePublicPreview } from './join'
import { checkName, derivedName, looksDerived, saveNameError, shouldAskName } from './names'
import { emailError, resendButton, sendErrorMessage, verifyFailure } from './signin'

const err = (code: string | undefined, message = 'x') => Object.assign(new Error(message), { code })

describe('sign-in flow', () => {
  it('checks email with the API rule', () => {
    expect(emailError(' Alex@Example.com ')).toBeNull()
    expect(emailError('alex@example')).toBe('Enter a valid email')
    expect(emailError('')).toBe('Enter a valid email')
  })

  it('maps send failures to friendly copy, including 429', () => {
    expect(sendErrorMessage(err('RATE_LIMITED'))).toMatch(/Wait a few minutes/)
    expect(sendErrorMessage(err('NETWORK'))).toBe('Couldn’t send the link. Check your signal and try again.')
    expect(sendErrorMessage(err('BAD_EMAIL'))).toBe('Enter a valid email')
    expect(sendErrorMessage(err('OTHER', 'Nope'))).toBe('Nope')
  })

  it('runs Resend through Sent again and a 30 s cooldown', () => {
    expect(resendButton({ sentAt: 0, resentAt: null, sending: false }, 1_000)).toEqual({ label: 'Resend in 29 s', disabled: true })
    expect(resendButton({ sentAt: 0, resentAt: null, sending: false }, 30_000)).toEqual({ label: 'Resend link', disabled: false })
    expect(resendButton({ sentAt: 0, resentAt: null, sending: true }, 40_000)).toEqual({ label: 'Sending…', disabled: true })
    expect(resendButton({ sentAt: 0, resentAt: 40_000, sending: false }, 41_000)).toEqual({ label: 'Sent again', disabled: true })
    expect(resendButton({ sentAt: 0, resentAt: 40_000, sending: false }, 43_000)).toEqual({ label: 'Resend in 27 s', disabled: true })
    expect(resendButton({ sentAt: 0, resentAt: 40_000, sending: false }, 70_000)).toEqual({ label: 'Resend link', disabled: false })
  })

  it('treats a dead sign-in link as expired and a network failure as retry', () => {
    expect(verifyFailure(err('BAD_TOKEN'))).toEqual({ kind: 'expired' })
    expect(verifyFailure(err('NETWORK'))).toMatchObject({ kind: 'error', message: expect.stringMatching(/tap the link again/) })
  })
})

describe('name flow', () => {
  it('detects names derived from the email like ensureUser', () => {
    expect(derivedName('k7q2x@divvy.test')).toBe('K7q2x')
    expect(looksDerived('K7q2x', 'k7q2x@divvy.test')).toBe(true)
    expect(looksDerived('Alex', 'k7q2x@divvy.test')).toBe(false)
    expect(shouldAskName({ displayName: 'K7q2x', email: 'k7q2x@divvy.test' }, false)).toBe(true)
    expect(shouldAskName({ displayName: 'K7q2x', email: 'k7q2x@divvy.test' }, true)).toBe(false)
    expect(shouldAskName(null, false)).toBe(false)
  })

  it('validates live, with a counter from 70', () => {
    expect(checkName('   ')).toEqual({ error: 'Enter a name', canSave: false, counter: null })
    expect(checkName(' Alex ')).toEqual({ error: null, canSave: true, counter: null })
    expect(checkName('a'.repeat(70))).toMatchObject({ canSave: true, counter: '70/80' })
    expect(checkName('a'.repeat(81))).toEqual({ error: 'Use a name under 80 characters', canSave: false, counter: '81/80' })
  })

  it('shows the API BAD_NAME message inline and a signal message offline', () => {
    expect(saveNameError(err('BAD_NAME', 'Name can’t be blank'))).toBe('Name can’t be blank')
    expect(saveNameError(err('NETWORK'))).toBe('Couldn’t save. Check your signal and try again.')
  })
})

describe('join flow', () => {
  const authed = { group: { id: 'g1', name: 'Lisbon' }, members: [{ id: 'pA', name: 'Alex' }] }
  const valid = { groupName: 'Lisbon', inviterName: 'Alex', status: 'valid' as const }

  it('parses only well-formed public previews', () => {
    expect(parsePublicPreview(valid)).toEqual(valid)
    expect(parsePublicPreview({ ...valid, status: 'weird' })).toBeNull()
    expect(parsePublicPreview({ groupName: 1, status: 'valid' })).toBeNull()
    expect(parsePublicPreview(null)).toBeNull()
  })

  it('shows Join for a valid link you are not in', () => {
    expect(decideJoin({ publicPreview: valid, authed, yourGroupIds: ['g2'] })).toMatchObject({ kind: 'preview', groupName: 'Lisbon', members: authed.members })
    expect(decideJoin({ publicPreview: valid, authed: null, yourGroupIds: [] })).toEqual({ kind: 'loading' })
  })

  it('goes dead for expired, used, archived and unknown links', () => {
    for (const status of ['expired', 'used', 'archived'] as const) {
      expect(decideJoin({ publicPreview: { ...valid, status }, authed: null, yourGroupIds: [] })).toEqual({ kind: 'dead', reason: status })
      expect(deadCopy(status)).toBeTruthy()
    }
    expect(decideJoin({ publicPreview: 'missing', authed: null, yourGroupIds: [] })).toEqual({ kind: 'dead', reason: 'missing' })
  })

  it('opens the group when you are already a member', () => {
    expect(decideJoin({ publicPreview: valid, authed, yourGroupIds: ['g1'] })).toEqual({ kind: 'already', groupId: 'g1', groupName: 'Lisbon' })
    expect(decideJoin({ publicPreview: valid, authed, yourGroupIds: [], yourParticipantId: 'pA' })).toMatchObject({ kind: 'already' })
    expect(decideJoin({ publicPreview: { ...valid, status: 'archived' }, authed, yourGroupIds: ['g1'] })).toMatchObject({ kind: 'already' })
    expect(joinedWasAlreadyMember('g1', ['g1'])).toBe(true)
    expect(joinedWasAlreadyMember('g1', [])).toBe(false)
  })

  it('maps Join failures to a dead link or inline copy', () => {
    expect(joinFailure(err('ARCHIVED'))).toEqual({ dead: 'archived' })
    expect(joinFailure(err('BAD_TOKEN'))).toEqual({ dead: 'missing' })
    expect(joinFailure(err('NETWORK'))).toEqual({ error: 'Couldn’t join. Check your signal and try again.' })
    expect(deadReasonFromError(err('FORBIDDEN'))).toBe('wrong-email')
  })
})
