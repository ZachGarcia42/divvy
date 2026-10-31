import { describe, expect, it } from 'vitest'
import { editConflict } from './errors'

const failure = (code: string, status?: number) => Object.assign(new Error('x'), { code, status })

describe('editConflict', () => {
  it('a 409 STALE means someone else saved first', () => { expect(editConflict(failure('STALE', 409))).toBe('stale') })
  it('a deleted expense (404 NOT_FOUND) means it is gone', () => {
    expect(editConflict(failure('NOT_FOUND', 404))).toBe('gone')
    expect(editConflict(failure('EXPENSE_NOT_FOUND'))).toBe('gone')
    expect(editConflict(failure('HTTP_404', 404))).toBe('gone')
  })
  it('anything else is left to the user: validation, network, server errors', () => {
    expect(editConflict(failure('BAD_AMOUNT', 400))).toBeNull()
    expect(editConflict(failure('NETWORK'))).toBeNull()
    expect(editConflict(failure('INTERNAL', 500))).toBeNull()
    expect(editConflict(null)).toBeNull()
    expect(editConflict(new Error('plain'))).toBeNull()
  })
})
