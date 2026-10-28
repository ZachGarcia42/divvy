import { describe, expect, it } from 'vitest'
import { dragOffset, dragOutcome } from './sheet'

describe('grab pill gesture', () => {
  const o = (dy: number, vy: number, snap: 'compact' | 'tall', resizable = true) => dragOutcome({ dy, vy, snap, resizable })
  it('a small drag or a tap goes nowhere', () => {
    expect(o(0, 0, 'compact')).toBe('stay')
    expect(o(30, 0.1, 'compact')).toBe('stay')
    expect(o(-30, -0.1, 'compact')).toBe('stay')
  })
  it('dragging a compact sheet down dismisses it', () => {
    expect(o(120, 0.2, 'compact')).toBe('dismiss')
    expect(o(40, 1.2, 'compact')).toBe('dismiss')   // a quick flick
  })
  it('dragging up expands a compact sheet; a tall one just stays', () => {
    expect(o(-120, -0.2, 'compact')).toBe('expand')
    expect(o(-40, -1.2, 'compact')).toBe('expand')
    expect(o(-200, -1, 'tall')).toBe('stay')
  })
  it('dragging a tall sheet down shrinks it first, and a second drag dismisses', () => {
    expect(o(150, 0.3, 'tall')).toBe('collapse')
    expect(o(150, 0.3, 'compact')).toBe('dismiss')
  })
  it('a fixed-size sheet only dismisses or stays', () => {
    expect(o(-200, -2, 'tall', false)).toBe('stay')
    expect(o(150, 0.3, 'tall', false)).toBe('dismiss')
  })
  it('the panel follows the finger down, and barely moves up when it cannot grow', () => {
    expect(dragOffset(60, 'compact', true)).toBe(60)
    expect(dragOffset(-60, 'compact', true)).toBe(-60)
    expect(dragOffset(-400, 'compact', true)).toBe(-120)
    expect(dragOffset(-80, 'tall', true)).toBe(-10)
    expect(dragOffset(-80, 'tall', false)).toBe(-10)
  })
})
