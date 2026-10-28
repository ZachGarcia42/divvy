import { describe, expect, it } from 'vitest'
import { amountWidth } from './amount'

describe('amountWidth', () => {
  it('sizes to the placeholder while empty, and to the text once typed', () => {
    expect(amountWidth('', '0.00', 54)).toBe(amountWidth('0.00', '0.00', 54))
    expect(amountWidth('1234.56', '0.00', 54)).toBeGreaterThan(amountWidth('12', '0.00', 54))
  })
  it('gives digits more room than separators and scales with the font size', () => {
    expect(amountWidth('11', '0.00', 44)).toBeGreaterThan(amountWidth('..', '0.00', 44))
    expect(amountWidth('1', '0.00', 54)).toBeGreaterThan(amountWidth('1', '0.00', 44))
  })
  it('never collapses to zero', () => { expect(amountWidth('', '', 54)).toBeGreaterThan(0) })
})
