import { createHash, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseDeepLink } from '../links'
import { apiBase, backDepth, historyMove, sha256Hex, stepBackLite, webLinkUrl, type NavLite } from './web'

const T = 'AbCdEfGhIjKlMnOpQrSt_-0123456789xyzXYZ0123'

describe('web helpers', () => {
  it('maps /app/login and /app/invite links from the landing pages', () => {
    expect(parseDeepLink(webLinkUrl(`https://divvy.mooo.com/app/login?token=${T}&next=%2Finvite%2F${T}`))).toEqual({ kind: 'login', token: T, next: `/invite/${T}` })
    expect(parseDeepLink(webLinkUrl(`https://divvy.mooo.com/app/invite/${T}`))).toEqual({ kind: 'invite', token: T })
    expect(webLinkUrl('https://divvy.mooo.com/')).toBe('https://divvy.mooo.com/')
    expect(webLinkUrl('https://divvy.mooo.com/application/x')).toBe('https://divvy.mooo.com/application/x')
    expect(webLinkUrl(null)).toBeNull()
  })

  it('uses same-origin on web and the configured URL on native', () => {
    expect(apiBase('web', { api: 'https://divvy.mooo.com' })).toBe('')
    expect(apiBase('web', { webApi: 'http://localhost:8787/' })).toBe('http://localhost:8787')
    expect(apiBase('android', { api: 'https://divvy.mooo.com' })).toBe('https://divvy.mooo.com')
    expect(apiBase('ios', {})).toBe('http://localhost:8787')
  })

  it('hashes the nonce the way the API checks it', async () => {
    const raw = 'abcdef0123456789abcdef'
    expect(await sha256Hex(raw, webcrypto.subtle as never)).toBe(createHash('sha256').update(raw).digest('hex'))
  })
})

const nav = (over: Partial<NavLite> = {}): NavLite => ({ screen: 'groups', origin: null, seeAll: false, editingPay: false, overlay: false, ...over })

describe('browser Back depth', () => {
  it('keeps no entry on the bare Groups screen, one for each screen a step out', () => {
    expect(backDepth(nav())).toBe(0)
    for (const screen of ['group', 'activity', 'account', 'deleted']) expect(backDepth(nav({ screen }))).toBe(1)
    for (const screen of ['expense', 'settle', 'groupActivity']) expect(backDepth(nav({ screen }))).toBe(2)
  })
  it('counts the Activity feed a row was opened from, and the group a feed row opened', () => {
    expect(backDepth(nav({ screen: 'expense', origin: { at: 'expense', screen: 'activity' } }))).toBe(2)
    expect(backDepth(nav({ screen: 'group', origin: { at: 'group', screen: 'activity' } }))).toBe(2)
    expect(backDepth(nav({ screen: 'expense', origin: { at: 'group', screen: 'activity' } }))).toBe(3)
  })
  it('counts a sheet, the pay-names editor and a See all filter as a step of their own', () => {
    expect(backDepth(nav({ screen: 'group', overlay: true }))).toBe(2)
    expect(backDepth(nav({ overlay: true }))).toBe(1)
    expect(backDepth(nav({ screen: 'account', editingPay: true }))).toBe(2)
    expect(backDepth(nav({ screen: 'activity', seeAll: true }))).toBe(2)
  })
  it('steps the sheet first, then the filter, then out', () => {
    const start = nav({ screen: 'activity', seeAll: true, overlay: true })
    const one = stepBackLite(start)!
    expect(one).toMatchObject({ overlay: false, seeAll: true, screen: 'activity' })
    const two = stepBackLite(one)!
    expect(two).toMatchObject({ seeAll: false, screen: 'activity' })
    expect(stepBackLite(two)!.screen).toBe('groups')
    expect(stepBackLite(nav())).toBeNull()
  })
})

describe('browser history moves', () => {
  it('pushes the missing entries, goes back over the extra ones, and leaves a matching history alone', () => {
    expect(historyMove(0, 2)).toEqual({ push: 2 })
    expect(historyMove(2, 0)).toEqual({ back: 2 })
    expect(historyMove(1, 1)).toBeNull()
  })
})
