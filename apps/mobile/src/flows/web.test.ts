import { createHash, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseDeepLink } from '../links'
import { apiBase, sha256Hex, webLinkUrl } from './web'

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
