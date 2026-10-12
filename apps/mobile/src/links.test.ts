import { describe, expect, it } from 'vitest'
import { inviteFromNext, invitePath, isToken, parseDeepLink, parseInvitePreview, safeNext, tokenFromInput } from './links'

const T = 'AbCdEfGhIjKlMnOpQrSt_-0123456789xyzXYZ0123'

describe('deep links', () => {
  it('parses divvy:// login links with an optional safe next', () => {
    expect(parseDeepLink(`divvy://login?token=${T}`)).toEqual({ kind: 'login', token: T, next: null })
    expect(parseDeepLink(`divvy://login?token=${T}&next=%2Finvite%2F${T}`)).toEqual({ kind: 'login', token: T, next: `/invite/${T}` })
    for (const next of ['https%3A%2F%2Fevil.example', '%2F%2Fevil.example', '%2F..%2F%2Fevil.com', '%2Fa%2F..%2Fb']) {
      expect(parseDeepLink(`divvy://login?token=${T}&next=${next}`)).toMatchObject({ next: null })
    }
    expect(parseDeepLink('divvy://login?next=%2Fx')).toBeNull()
    expect(parseDeepLink('divvy://login?token=%E0%A4%A')).toBeNull()
    expect(parseDeepLink('divvy://login?token=short')).toBeNull()
  })

  it('accepts invite links on the scheme and the web origin', () => {
    expect(parseDeepLink(`divvy://invite/${T}`)).toEqual({ kind: 'invite', token: T })
    expect(parseDeepLink(`https://divvy.example/invite/${T}?x=1`)).toEqual({ kind: 'invite', token: T })
    expect(parseDeepLink(`http://divvy.mooo.com:8787/login?token=${T}`)).toEqual({ kind: 'login', token: T, next: null })
    expect(parseDeepLink('divvy://elsewhere')).toBeNull()
    expect(parseDeepLink(null)).toBeNull()
  })

  it('rejects invite tokens outside the strict charset (path traversal, spaces, bad escapes)', () => {
    for (const url of [
      'divvy://invite/..%2F..%2Fapi%2Fhealth',
      'divvy://invite/..%2Fgroups%2FGID%3F',
      'divvy://invite/abc%20def',
      `divvy://invite/${T}%20def`,
      'divvy://invite/%E0%A4%A',
      'divvy://invite/',
      'divvy://invite/%2F%2Fevil.com',
      'divvy://invite/@evil.com',
      `divvy://invite/${T}/../../api/health`,
    ]) expect(parseDeepLink(url), url).toBeNull()
    expect(inviteFromNext('/invite/..%2Fx')).toBeNull()
    expect(tokenFromInput('..%2F..%2Fapi%2Fhealth')).toBeNull()
    expect(tokenFromInput(`  https://x.example/invite/${T} `)).toBe(T)
    expect(isToken(T)).toBe(true)
  })

  it('encodes tokens into API paths and validates next like the API', () => {
    expect(invitePath(T, '/accept')).toBe(`/api/invites/${T}/accept`)
    expect(invitePath('../x')).toBe('/api/invites/..%2Fx')
    expect(safeNext('/invite/abc')).toBe('/invite/abc')
    expect(safeNext('/..//evil.com')).toBeNull()
    expect(safeNext('/a/../b')).toBeNull()
    expect(safeNext('/javascript:alert(1)')).toBeNull()
    expect(safeNext('/invite/abc def')).toBeNull()
  })

  it('pulls the invite token out of a next path', () => {
    expect(inviteFromNext(`/invite/${T}`)).toBe(T)
    expect(inviteFromNext('/groups/1')).toBeNull()
    expect(inviteFromNext(null)).toBeNull()
  })

  it('only accepts a well-formed invite preview', () => {
    expect(parseInvitePreview({ group: { id: 'g', name: 'Apt' }, members: [{ id: 'p', name: 'Al', blocked: false }], kind: 'group' }))
      .toEqual({ group: { id: 'g', name: 'Apt' }, members: [{ id: 'p', name: 'Al' }] })
    for (const bad of [{ ok: true }, null, [], { group: null, members: [] }, { group: { id: 'g', name: 1 }, members: [] }, { group: { id: 'g', name: 'A' } }, { group: { id: 'g', name: 'A' }, members: [null] }]) {
      expect(parseInvitePreview(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
