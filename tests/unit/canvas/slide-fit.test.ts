import { describe, expect, it } from 'vitest'
import { fitSlide, SLIDE_SIZE } from '../../../src/renderer/src/features/canvas/slideFit'

describe('SLIDE_SIZE', () => {
  it('is the v1 canvas', () => {
    expect(SLIDE_SIZE).toEqual({ width: 1280, height: 720 })
  })
})

describe('fitSlide', () => {
  it('is width-bound in a container wider than 16:9 is tall', () => {
    const fit = fitSlide({ width: 640, height: 1000 })
    expect(fit.scale).toBe(0.5)
    expect(fit).toEqual({ scale: 0.5, width: 640, height: 360 })
  })

  it('is height-bound in a short container', () => {
    const fit = fitSlide({ width: 4000, height: 360 })
    expect(fit.scale).toBe(0.5)
    expect(fit).toEqual({ scale: 0.5, width: 640, height: 360 })
  })

  it('letterboxes: the painted box keeps the slide aspect ratio, never the container one', () => {
    const fit = fitSlide({ width: 1000, height: 1000 })
    expect(fit.width / fit.height).toBeCloseTo(SLIDE_SIZE.width / SLIDE_SIZE.height, 10)
    expect(fit.width).toBeLessThanOrEqual(1000)
    expect(fit.height).toBeLessThanOrEqual(1000)
  })

  it('fills an exactly-sized container at 1:1', () => {
    expect(fitSlide({ width: 1280, height: 720 })).toEqual({ scale: 1, width: 1280, height: 720 })
  })

  it('upscales when nothing caps it', () => {
    expect(fitSlide({ width: 2560, height: 1440 }).scale).toBe(2)
  })

  it('honours maxScale — the canvas never blows a 1280px document up', () => {
    expect(fitSlide({ width: 2560, height: 1440 }, { maxScale: 1 }).scale).toBe(1)
    // The cap must not disturb a fit that was already under it.
    expect(fitSlide({ width: 640, height: 360 }, { maxScale: 1 }).scale).toBe(0.5)
  })

  it('accepts a non-default slide size, for a v2 canvas', () => {
    const fit = fitSlide({ width: 500, height: 500 }, { slide: { width: 1000, height: 500 } })
    expect(fit).toEqual({ scale: 0.5, width: 500, height: 250 })
  })

  // A ref measures 0x0 before the first layout and in every happy-dom test, and ResizeObserver
  // can report a detached node as 0-height. `scale(NaN)` and `scale(Infinity)` are invalid
  // declarations: the browser drops them and paints a full-size 1280px frame bursting out of
  // whatever container it was in. Zero is the only safe answer.
  it.each([
    ['zero width', { width: 0, height: 720 }],
    ['zero height', { width: 1280, height: 0 }],
    ['negative', { width: -100, height: -100 }],
    ['NaN', { width: Number.NaN, height: 720 }],
    ['Infinity', { width: Number.POSITIVE_INFINITY, height: 720 }],
  ])('collapses a %s container to scale 0, never NaN or Infinity', (_label, container) => {
    expect(fitSlide(container)).toEqual({ scale: 0, width: 0, height: 0 })
  })

  it('collapses a degenerate slide size or a non-positive maxScale to scale 0', () => {
    expect(fitSlide({ width: 100, height: 100 }, { slide: { width: 0, height: 0 } }).scale).toBe(0)
    expect(fitSlide({ width: 100, height: 100 }, { maxScale: 0 }).scale).toBe(0)
    expect(fitSlide({ width: 100, height: 100 }, { maxScale: -1 }).scale).toBe(0)
  })
})
