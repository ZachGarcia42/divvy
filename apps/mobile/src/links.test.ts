import { describe, expect, it } from 'vitest'
import { inviteFromNext, parseDeepLink } from './links'

describe('deep links', () => {
  it('parses divvy:// login links with an optional next', () => {
    expect(parseDeepLink('divvy://login?token=abc%2D1')).toEqual({ kind: 'login', token: 'abc-1', next: null })
    expect(parseDeepLink('divvy://login?token=t&next=%2Finvite%2Fxyz')).toEqual({ kind: 'login', token: 't', next: '/invite/xyz' })
    expect(parseDeepLink('divvy://login?token=t&next=https%3A%2F%2Fevil.example')).toMatchObject({ next: null })
    expect(parseDeepLink('divvy://login?token=t&next=%2F%2Fevil.example')).toMatchObject({ next: null })
    expect(parseDeepLink('divvy://login?next=%2Fx')).toBeNull()
  })

  it('parses invite links on the scheme and the web origin', () => {
    expect(parseDeepLink('divvy://invite/tok_123')).toEqual({ kind: 'invite', token: 'tok_123' })
    expect(parseDeepLink('https://divvy.example/invite/tok_123?x=1')).toEqual({ kind: 'invite', token: 'tok_123' })
    expect(parseDeepLink('http://divvy.mooo.com:8787/login?token=q')).toEqual({ kind: 'login', token: 'q', next: null })
    expect(parseDeepLink('divvy://elsewhere')).toBeNull()
    expect(parseDeepLink(null)).toBeNull()
  })

  it('pulls the invite token out of a next path', () => {
    expect(inviteFromNext('/invite/abc')).toBe('abc')
    expect(inviteFromNext('/groups/1')).toBeNull()
    expect(inviteFromNext(null)).toBeNull()
  })
})
