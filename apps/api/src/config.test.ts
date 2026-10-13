import { describe, expect, it } from 'vitest'
import { checkStartupEnv } from './config.ts'

describe('startup env', () => {
  it('refuses to start in locked mode without WEB_ORIGIN', () => {
    for (const env of [{ DEV_SIGNIN_EMAILS: 'a@b.co' }, { DEV_SIGNIN_EMAILS: '' }, { DEV_SIGNIN_EMAILS: 'a@b.co', WEB_ORIGIN: '  ' }]) {
      const result = checkStartupEnv(env)
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toMatch(/WEB_ORIGIN is not set/)
    }
  })

  it('warns loudly in open dev mode without WEB_ORIGIN', () => {
    expect(checkStartupEnv({})).toEqual({ ok: true, warnings: [expect.stringMatching(/WARNING: WEB_ORIGIN is not set/)] })
  })

  it('accepts a real origin and rejects one with a path', () => {
    expect(checkStartupEnv({ DEV_SIGNIN_EMAILS: 'a@b.co', WEB_ORIGIN: 'http://divvy.mooo.com:8787' })).toEqual({ ok: true, warnings: [] })
    expect(checkStartupEnv({ WEB_ORIGIN: 'https://divvy.example.com/' })).toEqual({ ok: true, warnings: [] })
    expect(checkStartupEnv({ WEB_ORIGIN: 'https://divvy.example.com/app' }).ok).toBe(false)
    expect(checkStartupEnv({ WEB_ORIGIN: 'divvy.example.com' }).ok).toBe(false)
  })
})
