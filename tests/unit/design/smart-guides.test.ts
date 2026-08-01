/**
 * Smart-guide detection & snapping (M3.7) — pure. A moving rect is compared against other elements
 * and the slide box; the nearest edge/centre within the threshold wins each axis. Mutation guards
 * mark the threshold and delta assertions.
 */

import { describe, expect, it } from 'vitest'
import type { SlRect } from '../../../src/shared/design/bridge-protocol'
import { GUIDE_THRESHOLD, snapRectToGuides } from '../../../src/shared/design/smart-guides'

const r = (x: number, y: number, width: number, height: number): SlRect => ({ x, y, width, height })
const SLIDE = { width: 1280, height: 720 }

describe('snapRectToGuides', () => {
  it('snaps a left edge to a nearby target left edge within the threshold', () => {
    const moving = r(103, 300, 50, 50) // left at 103
    const target = r(100, 0, 40, 40) // left at 100 → 3px away, within threshold
    const { rect, guides } = snapRectToGuides(moving, [target], SLIDE)
    expect(rect.x).toBe(100) // snapped
    expect(rect.y).toBe(300) // untouched — no vertical alignment in range
    expect(guides.some((g) => g.orientation === 'vertical' && g.position === 100)).toBe(true)
  })

  it('snaps centres together (both axes) when a target centre is in range', () => {
    // moving centre = (100+? ); place moving so its centre is 2px off the target centre on each axis.
    const target = r(200, 200, 100, 100) // centre (250, 250)
    const moving = r(202, 198, 100, 100) // centre (252, 248) → 2px, 2px off
    const { rect } = snapRectToGuides(moving, [target], SLIDE)
    expect(rect.x + rect.width / 2).toBeCloseTo(250)
    expect(rect.y + rect.height / 2).toBeCloseTo(250)
  })

  it('snaps to the slide horizontal centre (640)', () => {
    const moving = r(587, 10, 100, 40) // centre x = 637 → 3px from 640
    const { rect, guides } = snapRectToGuides(moving, [], SLIDE)
    expect(rect.x + rect.width / 2).toBeCloseTo(640)
    expect(guides.some((g) => g.orientation === 'vertical' && g.position === 640)).toBe(true)
  })

  it('does not snap when nothing is within the threshold', () => {
    const moving = r(500, 500, 40, 40)
    const target = r(0, 0, 40, 40)
    const { rect, guides } = snapRectToGuides(moving, [target], SLIDE, GUIDE_THRESHOLD)
    expect(rect).toEqual(moving) // unchanged
    expect(guides).toEqual([])
  })

  it('respects the threshold boundary exactly (mutation guard)', () => {
    const target = r(100, 400, 40, 40) // left at 100
    // Exactly at threshold: should still snap.
    const atEdge = snapRectToGuides(r(100 + GUIDE_THRESHOLD, 0, 40, 40), [target], SLIDE)
    expect(atEdge.rect.x).toBe(100)
    // One past the threshold: must not snap.
    const past = snapRectToGuides(r(100 + GUIDE_THRESHOLD + 1, 0, 40, 40), [target], SLIDE)
    expect(past.rect.x).toBe(100 + GUIDE_THRESHOLD + 1)
  })

  it('picks the nearest of two competing snaps on an axis', () => {
    const near = r(105, 400, 40, 40) // left 105 (5 away)
    const nearer = r(102, 400, 40, 40) // left 102 (2 away)
    const moving = r(100, 0, 40, 40) // left 100 → nearer wins (snap to 102)
    const { rect } = snapRectToGuides(moving, [near, nearer], SLIDE)
    expect(rect.x).toBe(102)
  })
})
