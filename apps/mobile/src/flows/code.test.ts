import { describe, expect, it } from 'vitest'
import { codeFailure, sanitizeCode, shouldSubmitCode } from './code'

const err = (code: string | undefined, extra: Record<string, unknown> = {}) => Object.assign(new Error('x'), { code, ...extra })

describe('sign-in code', () => {
  it('keeps digits only and handles pastes', () => {
    expect(sanitizeCode('12a3')).toBe('123')
    expect(sanitizeCode('1234567')).toBe('123456')
    expect(sanitizeCode('123 456')).toBe('123456')
    expect(sanitizeCode('123-456')).toBe('123456')
    expect(sanitizeCode('Your Divvy code is 048213. It expires in 10 minutes.')).toBe('048213')
    expect(sanitizeCode('048213 is your Divvy sign-in code')).toBe('048213')
    expect(sanitizeCode('')).toBe('')
  })

  it('auto-submits once at 6 digits', () => {
    expect(shouldSubmitCode('12345', null, false)).toBe(false)
    expect(shouldSubmitCode('123456', null, false)).toBe(true)
    expect(shouldSubmitCode('123456', '123456', false)).toBe(false)
    expect(shouldSubmitCode('123456', null, true)).toBe(false)
  })

  it('maps code errors to inline copy and points expired/locked at Resend', () => {
    expect(codeFailure(err('BAD_CODE', { attemptsLeft: 3 }))).toEqual({ message: 'That code isn’t right. 3 tries left.', pointToResend: false, clearField: true })
    expect(codeFailure(err('BAD_CODE', { attemptsLeft: 1 })).message).toBe('That code isn’t right. 1 try left.')
    expect(codeFailure(err('CODE_EXPIRED'))).toMatchObject({ pointToResend: true, message: expect.stringMatching(/Resend/) })
    expect(codeFailure(err('CODE_LOCKED'))).toEqual({ message: 'Too many tries. Tap Resend for a new code.', pointToResend: true, clearField: true })
    expect(codeFailure(err('RATE_LIMITED')).message).toMatch(/Wait a few minutes/)
    expect(codeFailure(err('HTTP_502', { status: 502 })).message).toMatch(/Check your signal/)
    expect(codeFailure(err('NETWORK')).clearField).toBe(false)
  })
})
