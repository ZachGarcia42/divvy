import { describe, expect, it } from 'vitest'
import { dragOffset, dragOutcome } from './sheet'

describe('grab pill gesture', () => {
  const o = (dy: number, vy: number, snap: 'compact' | 'tall', resizable = true, height?: number) => dragOutcome({ dy, vy, snap, resizable, height })
  it('a small drag or a tap goes nowhere', () => {
    expect(o(0, 0, 'compact')).toBe('stay')
    expect(o(30, 0.1, 'compact')).toBe('stay')
    expect(o(-30, -0.1, 'compact')).toBe('stay')
  })
  it('a 40px drag never dismisses, however quickly it is made', () => {
    expect(o(40, 0.1, 'compact', true, 400)).toBe('stay')
    expect(o(40, 3, 'compact', true, 400)).toBe('stay')
    expect(o(40, 3, 'compact', false, 400)).toBe('stay')
    expect(o(40, 3, 'compact')).toBe('stay')
  })
  it('dragging a compact sheet down dismisses it only past a third of its height', () => {
    expect(o(130, 0.2, 'compact', true, 400)).toBe('stay')      // 130 < 133
    expect(o(140, 0.2, 'compact', true, 400)).toBe('dismiss')   // 140 > 133
    expect(o(100, 0.2, 'compact', true, 240)).toBe('dismiss')   // 100 > 80
    expect(o(150, 0.3, 'compact', true, 900)).toBe('stay')      // tall panels need a longer drag
  })
  it('a fast downward flick dismisses a compact sheet even when short of a third', () => {
    expect(o(70, 1.2, 'compact', true, 400)).toBe('dismiss')
    expect(o(70, 0.5, 'compact', true, 400)).toBe('stay')       // too slow to be a flick
  })
  it('dragging up expands a compact sheet; a tall one just stays', () => {
    expect(o(-120, -0.2, 'compact')).toBe('expand')
    expect(o(-40, -1.2, 'compact')).toBe('expand')
    expect(o(-200, -1, 'tall')).toBe('stay')
  })
  it('dragging a tall sheet down shrinks it first, and a second drag dismisses', () => {
    expect(o(150, 0.3, 'tall')).toBe('collapse')
    expect(o(70, 1.5, 'tall')).toBe('collapse')
    expect(o(40, 3, 'tall')).toBe('stay')
    expect(o(150, 0.3, 'compact', true, 300)).toBe('dismiss')
  })
  it('a fixed-size sheet only dismisses or stays', () => {
    expect(o(-200, -2, 'tall', false)).toBe('stay')
    expect(o(150, 0.3, 'tall', false, 400)).toBe('dismiss')
    expect(o(100, 0.3, 'tall', false, 800)).toBe('stay')
  })
  it('the panel follows the finger down, and barely moves up when it cannot grow', () => {
    expect(dragOffset(60, 'compact', true)).toBe(60)
    expect(dragOffset(-60, 'compact', true)).toBe(-60)
    expect(dragOffset(-400, 'compact', true)).toBe(-120)
    expect(dragOffset(-80, 'tall', true)).toBe(-10)
    expect(dragOffset(-80, 'tall', false)).toBe(-10)
  })
})
