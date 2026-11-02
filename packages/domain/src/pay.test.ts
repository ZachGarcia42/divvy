import { describe, expect, it } from 'vitest'
import { assertHandle, buildPayLink, checkHandle, payAmountText, payLinksFor, payNote, providerSupports } from './index.ts'

describe('payment handles', () => {
  it('accepts valid handles and strips @, $ and pasted links', () => {
    expect(checkHandle('venmo', '@maya-r_9')).toEqual({ ok: true, value: 'maya-r_9' })
    expect(checkHandle('venmo', 'https://venmo.com/u/Maya-Rios')).toEqual({ ok: true, value: 'Maya-Rios' })
    expect(checkHandle('venmo', 'account.venmo.com/u/Maya-Rios?x=1')).toEqual({ ok: true, value: 'Maya-Rios' })
    expect(checkHandle('paypal', 'paypal.me/mayarios/20')).toEqual({ ok: true, value: 'mayarios' })
    expect(checkHandle('paypal', 'https://www.paypal.com/paypalme/mayarios')).toEqual({ ok: true, value: 'mayarios' })
    expect(checkHandle('cashapp', '$mayarios')).toEqual({ ok: true, value: 'mayarios' })
    expect(checkHandle('cashapp', 'https://cash.app/$mayarios')).toEqual({ ok: true, value: 'mayarios' })
  })

  it('treats empty and null as clearing the handle', () => {
    for (const input of [null, undefined, '', '   ']) expect(checkHandle('venmo', input)).toEqual({ ok: true, value: null })
  })

  it('rejects the wrong shape', () => {
    for (const bad of ['abcd', 'has space', 'a'.repeat(31), 'a/b/c', 'emoji😀name', '@@maya12', 'maya.rios']) expect(checkHandle('venmo', bad).ok).toBe(false)
    for (const bad of ['pay pal', 'a'.repeat(21), 'maya_rios', 'ma-ya']) expect(checkHandle('paypal', bad).ok).toBe(false)
    for (const bad of ['1234', 'a'.repeat(21), 'may a', '$$maya', 'ma-ya']) expect(checkHandle('cashapp', bad).ok).toBe(false)
    expect(checkHandle('venmo', 42).ok).toBe(false)
    expect(checkHandle('venmo', 'x'.repeat(500)).ok).toBe(false)
    expect(() => assertHandle('cashapp', 'no way')).toThrow(/cashtag/)
  })

  it('never lets a link, query or path character through', () => {
    for (const bad of ['maya&amount=1', 'maya?x=1', 'maya#a', 'maya%2Cevil', 'maya,evil', 'ma ya/../x']) {
      expect(buildPayLink('venmo', bad, 1000, 'USD')).toBeNull()
    }
  })
})

describe('payment amounts', () => {
  it('writes minor units as a plain decimal', () => {
    expect(payAmountText(4250, 'USD')).toBe('42.50')
    expect(payAmountText(5, 'USD')).toBe('0.05')
    expect(payAmountText(100, 'USD')).toBe('1.00')
    expect(payAmountText(500, 'JPY')).toBe('500')
    expect(payAmountText(12345, 'KWD')).toBe('12.345')
    expect(() => payAmountText(-1, 'USD')).toThrow()
    expect(() => payAmountText(1.5, 'USD')).toThrow()
  })
})

describe('payment links', () => {
  const note = payNote('Lisbon trip')
  it('builds the Venmo web pay link with the amount and a private note', () => {
    const link = buildPayLink('venmo', 'maya-rios', 4250, 'USD', note)!
    expect(link.url).toBe('https://account.venmo.com/pay?txn=pay&recipients=%2Cmaya-rios&amount=42.50&note=Divvy%3A%20Lisbon%20trip&audience=private')
    expect(link.noteIncluded).toBe(true)
    expect(link.url.startsWith('venmo:')).toBe(false)
  })
  it('encodes notes so they cannot add parameters', () => {
    const link = buildPayLink('venmo', 'maya-rios', 100, 'USD', payNote('A&B=1 #x'))!
    expect(new URL(link.url).searchParams.get('note')).toBe('Divvy: A&B=1 #x')
    expect(new URL(link.url).searchParams.get('amount')).toBe('1.00')
  })
  it('builds PayPal.me and Cash App links, which carry no note', () => {
    expect(buildPayLink('paypal', 'mayarios', 4250, 'USD', note)).toEqual({ provider: 'paypal', amount: '42.50', noteIncluded: false, url: 'https://paypal.me/mayarios/42.50USD' })
    expect(buildPayLink('cashapp', 'mayarios', 4250, 'USD', note)).toEqual({ provider: 'cashapp', amount: '42.50', noteIncluded: false, url: 'https://cash.app/$mayarios/42.50' })
  })
  it('is USD only for Venmo and Cash App; PayPal takes the currency code', () => {
    expect(providerSupports('venmo', 'EUR')).toBe(false)
    expect(providerSupports('cashapp', 'GBP')).toBe(false)
    expect(providerSupports('paypal', 'eur')).toBe(true)
    expect(buildPayLink('venmo', 'maya-rios', 1000, 'EUR')).toBeNull()
    expect(buildPayLink('cashapp', 'mayarios', 1000, 'EUR')).toBeNull()
    expect(buildPayLink('paypal', 'mayarios', 1000, 'EUR')!.url).toBe('https://paypal.me/mayarios/10.00EUR')
    expect(buildPayLink('paypal', 'mayarios', 500, 'JPY')!.url).toBe('https://paypal.me/mayarios/500JPY')
  })
  it('returns nothing without a handle or an amount', () => {
    expect(buildPayLink('venmo', null, 1000, 'USD')).toBeNull()
    expect(buildPayLink('venmo', '', 1000, 'USD')).toBeNull()
    expect(buildPayLink('venmo', 'maya-rios', 0, 'USD')).toBeNull()
    expect(buildPayLink('venmo', 'maya-rios', -5, 'USD')).toBeNull()
    expect(payLinksFor(null, 1000, 'USD')).toEqual([])
  })
  it('lists the links the payee can take, Venmo first', () => {
    expect(payLinksFor({ cashapp: 'mayarios', venmo: 'maya-rios' }, 1000, 'USD').map((l) => l.provider)).toEqual(['venmo', 'cashapp'])
    expect(payLinksFor({ cashapp: 'mayarios', venmo: 'maya-rios', paypal: 'mayarios' }, 1000, 'EUR').map((l) => l.provider)).toEqual(['paypal'])
  })
  it('keeps the note short', () => {
    expect(payNote('')).toBe('Divvy')
    expect(payNote('x'.repeat(200)).length).toBe('Divvy: '.length + 60)
  })
})
