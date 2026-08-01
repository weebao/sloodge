import { describe, expect, it } from 'vitest'
import {
  clampSlideIndex,
  createPresentState,
  keyToPresentIntent,
  reducePresent,
  type PresentState,
} from '../../../src/renderer/src/features/present/presentMachine'

const state = (index: number, slideCount = 5, blank = false): PresentState => ({
  index,
  slideCount,
  blank,
})

describe('clampSlideIndex', () => {
  it('pins into range and collapses an empty deck to 0, never -1', () => {
    expect(clampSlideIndex(3, 5)).toBe(3)
    expect(clampSlideIndex(-2, 5)).toBe(0)
    expect(clampSlideIndex(9, 5)).toBe(4)
    expect(clampSlideIndex(0, 0)).toBe(0)
    expect(clampSlideIndex(4, 0)).toBe(0)
  })
})

describe('createPresentState', () => {
  it('opens at the (clamped) start index, unblanked', () => {
    expect(createPresentState(2, 5)).toEqual({ index: 2, slideCount: 5, blank: false })
    expect(createPresentState(99, 5)).toEqual({ index: 4, slideCount: 5, blank: false })
  })
})

describe('reducePresent navigation', () => {
  it('advances and goes back one slide', () => {
    expect(reducePresent(state(1), 'next').index).toBe(2)
    expect(reducePresent(state(1), 'prev').index).toBe(0)
  })

  // The clamp is the rule that matters: a talk must never wrap. Mutating `next` to wrap (`% count`)
  // or dropping the clamp reddens this.
  it('does not advance past the last slide (no wrap)', () => {
    const last = state(4, 5)
    const next = reducePresent(last, 'next')
    expect(next.index).toBe(4)
    // Referentially identical, so React's dispatch bails out of a re-render.
    expect(next).toBe(last)
  })

  it('does not go before the first slide (no wrap)', () => {
    const first = state(0, 5)
    const prev = reducePresent(first, 'prev')
    expect(prev.index).toBe(0)
    expect(prev).toBe(first)
  })

  it('jumps to the ends with first/last', () => {
    expect(reducePresent(state(2), 'first').index).toBe(0)
    expect(reducePresent(state(2), 'last').index).toBe(4)
  })

  it('leaves blank untouched while navigating', () => {
    expect(reducePresent(state(1, 5, true), 'next').blank).toBe(true)
  })
})

describe('reducePresent blank + exit', () => {
  it('toggles the blank flag', () => {
    expect(reducePresent(state(1, 5, false), 'toggle-blank').blank).toBe(true)
    expect(reducePresent(state(1, 5, true), 'toggle-blank').blank).toBe(false)
  })

  it('leaves the index unchanged when blanking', () => {
    expect(reducePresent(state(2), 'toggle-blank').index).toBe(2)
  })

  // Exit is a lifecycle event the container owns; the reducer recognises it but changes nothing.
  it('treats exit as a no-op on state', () => {
    const before = state(2, 5, true)
    expect(reducePresent(before, 'exit')).toBe(before)
  })
})

describe('keyToPresentIntent', () => {
  it.each([
    ['ArrowRight', 'next'],
    [' ', 'next'],
    ['Spacebar', 'next'],
    ['PageDown', 'next'],
    ['ArrowLeft', 'prev'],
    ['PageUp', 'prev'],
    ['Home', 'first'],
    ['End', 'last'],
    ['Escape', 'exit'],
    ['b', 'toggle-blank'],
    ['B', 'toggle-blank'],
  ])('maps %s to %s', (key, intent) => {
    expect(keyToPresentIntent(key)).toBe(intent)
  })

  it('returns null for keys the surface does not own, so the slide keeps them', () => {
    for (const key of ['a', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'x', '1']) {
      expect(keyToPresentIntent(key)).toBeNull()
    }
  })
})
