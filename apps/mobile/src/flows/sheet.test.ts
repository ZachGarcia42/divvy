import { describe, expect, it } from 'vitest'
import { dragOffset, dragOutcome, releaseVelocity, type DragSample } from './sheet'

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

describe('release velocity from recent move samples', () => {
  const s = (...pts: Array<[number, number]>): DragSample[] => pts.map(([t, y]) => ({ t, y }))
  it('a one-move flick is measured from the pointer-down sample, not from time 0', () => {
    // pointer down at t=5000ms, a single move of 150px 6ms later: react-native-web would report 150 / 5006 = 0.03 px/ms
    const v = releaseVelocity(s([5000, 0], [5006, 150]), 5010)
    expect(v).toBeCloseTo(25, 5)
    expect(dragOutcome({ dy: 150, vy: v, snap: 'compact', resizable: true, height: 600 })).toBe('dismiss')
  })
  it('a many-step flick uses the last ~150ms, not just the final (possibly slow) gap', () => {
    const steps = s([0, 0], [4, 12], [9, 24], [26, 36], [44, 48], [60, 60], [77, 72], [93, 84], [110, 96], [125, 108], [141, 120])
    const v = releaseVelocity(steps, 150)
    expect(v).toBeGreaterThan(0.7)
    expect(dragOutcome({ dy: 120, vy: v, snap: 'compact', resizable: true, height: 600 })).toBe('dismiss')
  })
  it('a slow drag is not a flick', () => {
    const slow = Array.from({ length: 11 }, (_, i): [number, number] => [i * 40, i * 12])
    expect(releaseVelocity(s(...slow), 420)).toBeCloseTo(0.3, 5)
    expect(dragOutcome({ dy: 120, vy: releaseVelocity(s(...slow), 420), snap: 'compact', resizable: true, height: 600 })).toBe('stay')
  })
  it('holding still before letting go cancels the flick', () => {
    expect(releaseVelocity(s([0, 0], [10, 150]), 400)).toBe(0)
  })
  it('only the end of the drag counts: a fast start then a slow finish is slow', () => {
    expect(releaseVelocity(s([0, 0], [10, 100], [400, 110], [450, 120], [500, 130]), 510)).toBeLessThan(0.3)
  })
  it('no usable samples, or a repeated timestamp, never divides by zero', () => {
    expect(releaseVelocity([], 10)).toBe(0)
    expect(releaseVelocity(s([5, 0]), 6)).toBe(0)
    expect(Number.isFinite(releaseVelocity(s([5, 0], [5, 80]), 6))).toBe(true)
  })
  it('a flick up reads negative', () => {
    expect(releaseVelocity(s([0, 0], [10, -90]), 12)).toBeLessThan(-0.7)
  })
  it('uses the times the pointer events happened, so a janky frame between handling them does not hide a flick', () => {
    // pointer down at 4457, one 100px move at 4534 (77ms later), release at 4767: a flick by event time...
    expect(releaseVelocity(s([4457, 0], [4534, 100]), 4767 - 150)).toBeGreaterThan(0.7)
    // ...but timed by when the handlers ran (down 4469, move 4698 after a 160ms stall) it is only 0.44 px/ms
    expect(releaseVelocity(s([4469, 0], [4698, 100]), 4781)).toBeLessThan(0.7)
  })
})
