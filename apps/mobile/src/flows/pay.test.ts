import { describe, expect, it } from 'vitest'
import { handleText, onReturn, payRowsFor, returnQuestion, stillOwed, type PendingPay } from './pay'

const maya = { venmo: 'maya-r', paypal: 'mayar', cashapp: 'mayar' }

describe('settle-up pay rows', () => {
  it('lists Venmo, PayPal and Cash App with the amount for a USD payee who set all three up', () => {
    const { rows, missing, nothing } = payRowsFor(maya, 4250, 'USD', 'Lisbon')
    expect(rows.map((r) => r.provider)).toEqual(['venmo', 'paypal', 'cashapp'])
    expect(rows.map((r) => r.label)).toEqual(['Venmo', 'PayPal', 'Cash App'])
    expect(rows.map((r) => r.handleText)).toEqual(['@maya-r', 'paypal.me/mayar', '$mayar'])
    expect(rows[0]!.sub).toBe('@maya-r · opens Venmo with $42.50 filled in')
    expect(rows[1]!.sub).toBe('paypal.me/mayar · opens with $42.50')
    expect(rows[2]!.url).toBe('https://cash.app/$mayar/42.50')
    expect(rows[0]!.url).toBe('https://account.venmo.com/pay?txn=pay&recipients=%2Cmaya-r&amount=42.50&note=Divvy%3A%20Lisbon&audience=private')
    expect(missing).toEqual([])
    expect(nothing).toBe(false)
  })

  it('hides Venmo and Cash App outside US dollars but keeps PayPal with the currency code', () => {
    const { rows, missing } = payRowsFor(maya, 1000, 'EUR', 'Berlin')
    expect(rows.map((r) => r.provider)).toEqual(['paypal'])
    expect(rows[0]!.url).toBe('https://paypal.me/mayar/10.00EUR')
    expect(missing).toEqual([])
  })

  it('reports the apps the payee has not set up, and when there are none at all', () => {
    expect(payRowsFor({ paypal: 'mayar' }, 1000, 'USD', 'T').missing).toEqual(['venmo', 'cashapp'])
    const none = payRowsFor({}, 1000, 'USD', 'T')
    expect(none.rows).toEqual([])
    expect(none.nothing).toBe(true)
    expect(payRowsFor(undefined, 1000, 'USD', 'T').nothing).toBe(true)
    // A EUR group where the payee only has Venmo: there is nothing this group can use.
    expect(payRowsFor({ venmo: 'maya-r' }, 1000, 'EUR', 'T').nothing).toBe(true)
  })

  it('shows no buttons for a zero amount', () => {
    expect(payRowsFor(maya, 0, 'USD', 'T').rows).toEqual([])
  })

  it('formats handles for display', () => {
    expect(handleText('venmo', 'a-b')).toBe('@a-b')
    expect(handleText('cashapp', 'ab')).toBe('$ab')
  })
})

describe('coming back from the payment app', () => {
  const pending: PendingPay = { provider: 'venmo', groupId: 'g', fromId: 'me', toId: 'maya', payeeName: 'Maya', minor: 4250, currency: 'USD', openedAt: 10_000, left: true }
  it('asks only after the app really went away for a moment', () => {
    expect(onReturn(pending, 10_000 + 1499)).toBe('wait')
    expect(onReturn(pending, 10_000 + 1500)).toBe('ask')
    expect(onReturn({ ...pending, left: false }, 10_000 + 60_000)).toBe('wait')
  })
  it('forgets nothing-pending and stale links', () => {
    expect(onReturn(null, 1)).toBe('forget')
    expect(onReturn(pending, 10_000 + 6 * 3600_000 + 1)).toBe('forget')
  })
  it('words the question without claiming anything happened', () => {
    const q = returnQuestion('Maya', 4250, 'USD', 'venmo')
    expect(q).toBe('Did you send Maya $42.50 on Venmo?')
    expect(q).not.toMatch(/paid|confirm/i)
  })
  it('only asks about a payment that is still owed', () => {
    const payments = [{ fromId: 'me', toId: 'maya', minor: 4250 }]
    expect(stillOwed(payments, pending)).toBe(true)
    expect(stillOwed(payments, { ...pending, minor: 1000 })).toBe(true)
    expect(stillOwed(payments, { ...pending, minor: 5000 })).toBe(false)
    expect(stillOwed([], pending)).toBe(false)
    expect(stillOwed(payments, { ...pending, toId: 'leo' })).toBe(false)
  })
})
