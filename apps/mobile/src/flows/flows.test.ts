import { describe, expect, it } from 'vitest'
import { createOnce, decideJoin, deadCopy, deadReasonFromError, joinFailure, joinedWasAlreadyMember, loadJoinView, parsePublicPreview } from './join'
import { checkStoredSession, createSessionExpiry, isSessionExpiry, loadSession, saveSession, SESSION_KEY, type KeyStore } from './session'
import { checkName, derivedName, looksDerived, saveNameError, shouldAskName } from './names'
import { cooldownAnnouncement, cooldownLeftMs, createCooldowns, emailError, resendButton, sendErrorMessage, verifyFailure } from './signin'

const err = (code: string | undefined, message = 'x', status?: number) => Object.assign(new Error(message), { code, status })

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
    expect(derivedName(`${'l'.repeat(120)}@x.co`)).toBe('L' + 'l'.repeat(79))
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
    expect(checkName('a'.repeat(81))).toEqual({ error: 'Use a name of 80 characters or fewer', canSave: false, counter: '81/80' })
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

describe('QA round 344', () => {
  const authedRaw = { group: { id: 'g1', name: 'Lisbon' }, members: [{ id: 'pA', name: 'Alex' }] }
  const parseAuthed = (v: unknown) => (v && typeof v === 'object' && 'group' in v ? v as typeof authedRaw & { youAreMember?: boolean } : null)
  const valid = { groupName: 'Lisbon', inviterName: 'Alex', status: 'valid' }
  const run = (over: Partial<Parameters<typeof loadJoinView>[0]>) => loadJoinView({
    publicPreview: async () => valid,
    authedPreview: async () => authedRaw,
    yourGroupIds: async () => [],
    parseAuthed,
    ...over,
  })

  it('keeps the invite (offline) for 5xx, timeouts, offline and an expired session', async () => {
    for (const failure of [err('HTTP_502', 'Request failed', 502), err('INTERNAL', 'x', 500), err('NETWORK'), err('UNAUTHENTICATED', 'Sign in', 401)]) {
      expect(await run({ publicPreview: async () => { throw failure } }), String(failure.code)).toEqual({ kind: 'offline' })
      expect(await run({ authedPreview: async () => { throw failure } }), String(failure.code)).toEqual({ kind: 'offline' })
    }
    expect(await run({ yourGroupIds: async () => { throw err('NETWORK') } })).toEqual({ kind: 'offline' })
    expect(deadReasonFromError(err('UNAUTHENTICATED', 'Sign in', 401))).toBeNull()
    expect(joinFailure(err('HTTP_503', 'Request failed', 503))).toEqual({ error: 'Couldn’t join. Check your signal and try again.' })
  })

  it('is dead only for a 404 or a real expired/used/archived status', async () => {
    expect(await run({ publicPreview: async () => { throw err('NOT_FOUND', 'x', 404) }, authedPreview: async () => { throw err('BAD_TOKEN', 'x', 400) } })).toEqual({ kind: 'dead', reason: 'missing' })
    for (const status of ['expired', 'used', 'archived']) {
      expect(await run({ publicPreview: async () => ({ ...valid, status }), authedPreview: async () => { throw err('BAD_TOKEN', 'x', 401) } })).toEqual({ kind: 'dead', reason: status })
    }
    expect(await run({ authedPreview: async () => { throw err('FORBIDDEN', 'x', 403) } })).toEqual({ kind: 'dead', reason: 'wrong-email' })
    expect(await run({})).toMatchObject({ kind: 'preview' })
  })

  it('says already a member before used/expired', async () => {
    expect(await run({ publicPreview: async () => ({ ...valid, status: 'used' }), authedPreview: async () => ({ ...authedRaw, youAreMember: true }) }))
      .toEqual({ kind: 'already', groupId: 'g1', groupName: 'Lisbon' })
    expect(decideJoin({ publicPreview: { ...valid, status: 'expired' } as never, authed: authedRaw, yourGroupIds: ['g1'] })).toMatchObject({ kind: 'already' })
  })

  it('ignores a second Join tap while one is in flight', async () => {
    const once = createOnce()
    let calls = 0
    let release!: () => void
    const task = () => new Promise<string>((resolve) => { calls += 1; release = () => resolve('ok') })
    const first = once(task)
    expect(await once(task)).toBeUndefined()
    release()
    expect(await first).toBe('ok')
    expect(calls).toBe(1)
    expect(await once(async () => 'again')).toBe('again')
  })

  it('maps 5xx and name errors on sign-in to retry copy', () => {
    for (const e of [err('HTTP_502', 'Request failed', 502), err('INTERNAL', 'Something went wrong', 500), err(undefined, 'Request failed'), err('HTTP_404', 'Request failed', 404)]) {
      expect(sendErrorMessage(e)).toBe('Couldn’t send the link. Check your signal and try again.')
    }
    expect(sendErrorMessage(err('BAD_NAME', 'Use a name of 80 characters or fewer', 400))).toBe('Use a name of 80 characters or fewer')
    expect(sendErrorMessage(err('BAD_NEXT', 'next must be a relative path like /invite/<token>', 400))).toBe('next must be a relative path like /invite/<token>')
    expect(sendErrorMessage(err('SUSPENDED', 'This account is suspended', 403))).toBe('This account is suspended')
    expect(verifyFailure(err('BAD_NAME', 'Use a name of 80 characters or fewer'))).toMatchObject({ kind: 'error', message: expect.stringMatching(/tap the link again/) })
    expect(verifyFailure(err('HTTP_502', 'Request failed', 502))).toMatchObject({ message: expect.not.stringMatching(/Request failed/) })
  })

  it('keys the resend cooldown by normalized email and clamps it to 0..30 s', () => {
    const cooldowns = createCooldowns()
    cooldowns.mark(' Alex@Example.com ', 1000)
    expect(cooldowns.last('alex@example.com')).toBe(1000)
    expect(cooldowns.last('sam@example.com')).toBeNull()
    expect(cooldownLeftMs(1000, 1000 - 3_600_000)).toBe(30_000)
    expect(cooldownLeftMs(1000, 1000 + 3_600_000)).toBe(0)
    expect(resendButton({ sentAt: 1_000_000, resentAt: null, sending: false }, 1_000_000 - 3_600_000)).toEqual({ label: 'Resend in 30 s', disabled: true })
    expect(cooldownAnnouncement(0, 30)).toMatch(/30 seconds/)
    expect(cooldownAnnouncement(30, 29)).toBeNull()
    expect(cooldownAnnouncement(1, 0)).toMatch(/resend the link now/)
  })

  it('loads, clears, and validates a stored session', async () => {
    const map = new Map<string, string>()
    const store: KeyStore = { get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v) }, remove: async (k) => { map.delete(k) } }
    const tok = 'A'.repeat(43)
    await saveSession(store, tok)
    expect(await loadSession(store)).toBe(tok)
    expect(await checkStoredSession(store, tok, async () => ({ userId: 'u' }))).toEqual({ ok: true, me: { userId: 'u' } })
    expect(await checkStoredSession(store, tok, async () => { throw err('NETWORK') })).toEqual({ ok: false, reason: 'offline' })
    expect(map.has(SESSION_KEY)).toBe(true)
    expect(await checkStoredSession(store, tok, async () => { throw err('UNAUTHENTICATED', 'Sign in', 401) })).toEqual({ ok: false, reason: 'signed-out' })
    expect(map.has(SESSION_KEY)).toBe(false)
    await saveSession(store, tok)
    expect(await checkStoredSession(store, tok, async () => null)).toEqual({ ok: false, reason: 'signed-out' })
    expect(await loadSession(store)).toBeNull()
    map.set(SESSION_KEY, '../bad token')
    expect(await loadSession(store)).toBeNull()
    expect(map.has(SESSION_KEY)).toBe(false)
    await saveSession(store, null)
  })

describe('session expiry after startup', () => {
  it('fires for authenticated 401s that are not BAD_TOKEN', () => {
    const expiry = createSessionExpiry()
    let fired = 0
    expiry.set(() => { fired += 1 })
    expiry.report(err('UNAUTHENTICATED', 'Sign in', 401), true)
    expiry.report(err('HTTP_401', 'Request failed', 401), true)
    expiry.report(err('BAD_TOKEN', 'That invite is no longer valid', 401), true)
    expiry.report(err('UNAUTHENTICATED', 'Sign in', 401), false)
    expiry.report(err('FORBIDDEN', 'x', 403), true)
    expiry.report(err('NETWORK'), true)
    expect(fired).toBe(2)
    expiry.set(null)
    expiry.report(err('UNAUTHENTICATED', 'Sign in', 401), true)
    expect(fired).toBe(2)
    expect(isSessionExpiry(err('BAD_TOKEN', 'x', 401), true)).toBe(false)
  })
})
