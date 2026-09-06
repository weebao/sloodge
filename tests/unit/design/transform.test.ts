/**
 * The pure transform-string algebra M3.6's rotate + flip are built on. Every property here is
 * source-string in / source-string out, so the merge math — the thing that must never clobber an
 * existing `translate` — is pinned without a DOM. Mutation targets are called out inline.
 *
 * The geometric claims (flip keeps the tilt; the canonical order is a parent-space translate) are
 * checked with a tiny CSS-semantics evaluator written here, not with the module's own math, so a
 * test cannot agree with a wrong implementation by construction.
 */

import { describe, expect, it } from 'vitest'
import {
  composeTransform,
  inspectTransform,
  withFlip,
  withRotation,
  withTranslateOffset,
  type TransformParts,
} from '../../../src/shared/design/transform'

/** The parts of an editable value, or a thrown failure — so a test reads as `parts('…').rotate`. */
function parts(transform: string | null): TransformParts {
  const shape = inspectTransform(transform)
  if (!shape.editable) throw new Error(`expected editable, got: ${shape.reason}`)
  return shape.parts
}

/** The refusal reason of an opaque value, or a thrown failure. */
function reason(transform: string): string {
  const shape = inspectTransform(transform)
  if (shape.editable) throw new Error(`expected opaque: ${transform}`)
  return shape.reason
}

/**
 * Apply a canonical `translate(px) rotate(deg) scale()` string to a point the way CSS does — the
 * function list is applied right to left, so `scale` acts first and `translate` last. Independent
 * of `transform.ts`: it re-tokenizes with its own regex and does its own trigonometry.
 */
function applyCss(transform: string, point: { x: number; y: number }): { x: number; y: number } {
  const fns = [...transform.matchAll(/([a-z]+)\(([^)]*)\)/g)].map((m) => ({
    name: m[1]!,
    args: m[2]!.split(',').map((a) => Number.parseFloat(a)),
  }))
  let { x, y } = point
  for (const fn of fns.toReversed()) {
    if (fn.name === 'scale') {
      x *= fn.args[0]!
      y *= fn.args[1] ?? fn.args[0]!
    } else if (fn.name === 'rotate') {
      const r = (fn.args[0]! * Math.PI) / 180
      const nx = x * Math.cos(r) - y * Math.sin(r)
      y = x * Math.sin(r) + y * Math.cos(r)
      x = nx
    } else if (fn.name === 'translate') {
      x += fn.args[0]!
      y += fn.args[1] ?? 0
    }
  }
  return { x, y }
}

describe('inspectTransform — editable shapes', () => {
  it('no transform, an empty value and `none` are all the identity', () => {
    for (const value of [null, '', '   ', 'none']) {
      expect(parts(value)).toEqual({ translate: null, rotate: 0, scale: { sx: 1, sy: 1 } })
    }
  })

  it('reads the three canonical functions into parts', () => {
    expect(parts('translate(10px, 20px) rotate(45deg) scale(2, 3)')).toEqual({
      translate: '10px, 20px',
      rotate: 45,
      scale: { sx: 2, sy: 3 },
    })
  })

  it('any subset in canonical order is editable', () => {
    expect(parts('rotate(-30deg)').rotate).toBe(-30)
    expect(parts('translate(1px, 2px) scale(2)').scale).toEqual({ sx: 2, sy: 2 })
    expect(parts('rotate(10deg) scale(0.5)').translate).toBeNull()
  })

  it('carries translate verbatim, so a percentage translate is rotatable', () => {
    // Mutation guard: parsing the translate numerically (and losing the `%`) reds here.
    expect(parts('translate(-50%, -50%) rotate(10deg)').translate).toBe('-50%, -50%')
  })

  it('folds the single-axis aliases into the canonical form', () => {
    expect(parts('scaleX(-1)').scale).toEqual({ sx: -1, sy: 1 })
    expect(parts('scaleY(-1)').scale).toEqual({ sx: 1, sy: -1 })
    expect(parts('translateX(8px)').translate).toBe('8px, 0')
    expect(parts('translateY(8px)').translate).toBe('0, 8px')
    expect(parts('rotateZ(15deg)').rotate).toBe(15)
  })

  it('function names are case-insensitive, as in CSS', () => {
    expect(parts('ROTATE(45deg)').rotate).toBe(45)
  })

  it('a bare number is read as degrees; a decimal angle survives', () => {
    expect(parts('rotate(45)').rotate).toBe(45)
    expect(parts('rotate(22.5deg)').rotate).toBe(22.5)
  })

  it('legal CSS number and unit spellings are editable: sign, exponent, uppercase unit, NONE', () => {
    // Round-1 minor: each of these used to be opaque, which cost the element every handle.
    expect(parts('rotate(45DEG)').rotate).toBe(45)
    expect(parts('rotate(+45deg)').rotate).toBe(45)
    expect(parts('rotate(1e2deg)').rotate).toBe(100)
    expect(parts('scale(+2)').scale).toEqual({ sx: 2, sy: 2 })
    expect(parts('scale(1e2)').scale).toEqual({ sx: 100, sy: 100 })
    expect(parts('NONE')).toEqual({ translate: null, rotate: 0, scale: { sx: 1, sy: 1 } })
  })
})

describe('inspectTransform — opaque shapes are refused with a reason, never reordered', () => {
  it('a matrix is opaque and the reason names it as written', () => {
    expect(reason('matrix(1, 0, 0, 1, 0, 0)')).toContain('matrix(1, 0, 0, 1, 0, 0)')
  })

  it('an unknown function anywhere in the list is opaque', () => {
    expect(reason('translate(1px, 2px) skewX(10deg)')).toContain('skewX(10deg)')
    expect(inspectTransform('rotate3d(0, 0, 1, 45deg)').editable).toBe(false)
  })

  it('non-canonical order is opaque, because the functions do not commute', () => {
    // Mutation guard: a stable re-sort into canonical order (the first cut) makes this editable.
    expect(reason('rotate(90deg) translate(100px, 0)')).toContain(
      'translate() comes after rotate()',
    )
    expect(inspectTransform('scale(2) rotate(10deg)').editable).toBe(false)
    expect(inspectTransform('scale(2) translate(1px)').editable).toBe(false)
  })

  it('a repeated family is opaque — two translates compose, and collapsing them would lose one', () => {
    expect(reason('translate(10px, 0) translate(5px, 0)')).toContain('appears more than once')
    expect(inspectTransform('rotate(10deg) rotate(20deg)').editable).toBe(false)
    expect(inspectTransform('scaleX(2) scale(3)').editable).toBe(false)
  })

  it('an angle unit the handles do not read is opaque', () => {
    expect(reason('rotate(0.5turn)')).toContain('not in degrees')
    expect(inspectTransform('rotate(1rad)').editable).toBe(false)
  })

  it('a scale that is not plain numbers is opaque', () => {
    expect(inspectTransform('scale(2px)').editable).toBe(false)
    expect(inspectTransform('scale(1, 2, 3)').editable).toBe(false)
  })

  it('a value the tokenizer would silently mangle (nested parens) is opaque', () => {
    // `parseTransform` would read this as `translate(calc(50% - 8px` and drop the rest.
    expect(inspectTransform('translate(calc(50% - 8px), 0)').editable).toBe(false)
    expect(inspectTransform('rotate(45deg) garbage').editable).toBe(false)
  })

  it('a translate with more than two lengths is opaque', () => {
    expect(inspectTransform('translate(1px, 2px, 3px)').editable).toBe(false)
  })

  it('a function name that is an Object.prototype key is opaque, not silently deleted', () => {
    // Round-1 minor: `constructor(1)` resolved through the prototype, read as editable identity, and
    // `composeTransform` then removed the declaration. Mutation guard: a plain object literal for
    // `FAMILY_OF` reds here.
    expect(inspectTransform('constructor(1)').editable).toBe(false)
    expect(inspectTransform('toString(1)').editable).toBe(false)
  })
})

describe('composeTransform', () => {
  it('emits canonical translate → rotate → scale and omits every identity part', () => {
    expect(composeTransform({ translate: '1px, 2px', rotate: 45, scale: { sx: 2, sy: 3 } })).toBe(
      'translate(1px, 2px) rotate(45deg) scale(2, 3)',
    )
    expect(composeTransform({ translate: null, rotate: 0, scale: { sx: 1, sy: 1 } })).toBe('')
  })

  it('a uniform scale is written in its short form', () => {
    expect(composeTransform({ translate: null, rotate: 0, scale: { sx: 2, sy: 2 } })).toBe(
      'scale(2)',
    )
  })

  it('round-trips a canonical value byte-exact through inspect', () => {
    for (const value of ['translate(10px, 20px)', 'rotate(30deg)', 'scale(-1, 1)', 'scale(2)']) {
      expect(composeTransform(parts(value))).toBe(value)
    }
  })
})

describe('withRotation', () => {
  it('composes rotate WITHOUT clobbering an existing translate', () => {
    // Mutation guard: dropping the translate on the floor reds here.
    expect(composeTransform(withRotation(parts('translate(10px, 20px)'), 30))).toBe(
      'translate(10px, 20px) rotate(30deg)',
    )
  })

  it('replaces an existing rotate, keeping translate and scale', () => {
    expect(
      composeTransform(withRotation(parts('translate(10px, 20px) rotate(15deg) scale(2)'), 60)),
    ).toBe('translate(10px, 20px) rotate(60deg) scale(2)')
  })

  it('rotating back to 0° removes the rotate function entirely', () => {
    expect(composeTransform(withRotation(parts('translate(10px, 20px) rotate(45deg)'), 0))).toBe(
      'translate(10px, 20px)',
    )
    expect(composeTransform(withRotation(parts('rotate(45deg)'), 0))).toBe('')
  })

  it('accepts negative angles', () => {
    expect(composeTransform(withRotation(parts(null), -90))).toBe('rotate(-90deg)')
  })

  it('the canonical order makes the translate a parent-space offset, whatever the rotation', () => {
    // The element's own origin lands at exactly the translate — the rotation does not turn it.
    const value = composeTransform(withRotation(parts('translate(10px, 20px)'), 90))
    expect(applyCss(value, { x: 0, y: 0 })).toEqual({ x: 10, y: 20 })
  })
})

describe('withFlip', () => {
  it('flip H introduces scale(-1, 1); flip V introduces scale(1, -1)', () => {
    expect(composeTransform(withFlip(parts(null), 'x'))).toBe('scale(-1, 1)')
    expect(composeTransform(withFlip(parts(null), 'y'))).toBe('scale(1, -1)')
  })

  it('composes into scale WITHOUT clobbering translate/rotate', () => {
    // Mutation guard: clobbering translate/rotate reds here.
    expect(composeTransform(withFlip(parts('translate(10px, 20px) rotate(30deg)'), 'x'))).toBe(
      'translate(10px, 20px) rotate(30deg) scale(-1, 1)',
    )
  })

  it('flip then flip on the same axis returns to the ORIGINAL value', () => {
    for (const start of ['', 'translate(5px, 5px)', 'rotate(45deg) scale(2)', 'scale(3)']) {
      // A flip must be its own inverse; an off-by-one in the scale math reds here.
      expect(composeTransform(withFlip(withFlip(parts(start), 'x'), 'x'))).toBe(start)
      expect(composeTransform(withFlip(withFlip(parts(start), 'y'), 'y'))).toBe(start)
    }
  })

  it('flipping both axes composes to scale(-1) and back to identity', () => {
    const both = withFlip(withFlip(parts(null), 'x'), 'y')
    expect(composeTransform(both)).toBe('scale(-1)')
    expect(composeTransform(withFlip(withFlip(both, 'x'), 'y'))).toBe('')
  })

  it('flipping a uniform scale keeps the short form after undoing', () => {
    expect(composeTransform(withFlip(parts('scale(2)'), 'x'))).toBe('scale(-2, 2)')
    expect(composeTransform(withFlip(parts('scale(-2, 2)'), 'x'))).toBe('scale(2)')
  })

  it('a flip mirrors within the rotated frame: the tilt is kept, not negated', () => {
    // A box tilted 30°: its right-edge midpoint after the flip lands exactly where its left-edge
    // midpoint was before — the mirror axis is the element's own, so the 30° tilt is preserved.
    // Checked with the independent evaluator, not the module's numbers.
    const upright = composeTransform(parts('rotate(30deg)'))
    const flipped = composeTransform(withFlip(parts('rotate(30deg)'), 'x'))
    expect(parts(flipped).rotate).toBe(30)
    const rightAfter = applyCss(flipped, { x: 100, y: 0 })
    const leftBefore = applyCss(upright, { x: -100, y: 0 })
    expect(rightAfter.x).toBeCloseTo(leftBefore.x)
    expect(rightAfter.y).toBeCloseTo(leftBefore.y)
  })
})

describe('withTranslateOffset', () => {
  it('adds to an absent translate', () => {
    expect(composeTransform(withTranslateOffset(parts(null), 16, 16)!)).toBe(
      'translate(16px, 16px)',
    )
  })

  it('adds to an existing px translate without clobbering rotate', () => {
    expect(
      composeTransform(withTranslateOffset(parts('translate(10px, 20px) rotate(45deg)'), 16, 16)!),
    ).toBe('translate(26px, 36px) rotate(45deg)')
  })

  it('a one-length translate and a bare 0 are px', () => {
    expect(composeTransform(withTranslateOffset(parts('translate(10px)'), 6, 6)!)).toBe(
      'translate(16px, 6px)',
    )
    expect(composeTransform(withTranslateOffset(parts('translate(0, 0)'), 1, 2)!)).toBe(
      'translate(1px, 2px)',
    )
  })

  it('an uppercase px unit is px', () => {
    expect(composeTransform(withTranslateOffset(parts('translate(10PX, 0)'), 16, 16)!)).toBe(
      'translate(26px, 16px)',
    )
  })

  it('refuses (null) rather than guessing when the translate is not px', () => {
    // Mutation guard: `parseFloat`-ing `-50%` to -50 and writing `-34px` reds here.
    expect(withTranslateOffset(parts('translate(-50%, -50%)'), 16, 16)).toBeNull()
    expect(withTranslateOffset(parts('translate(1em, 0)'), 16, 16)).toBeNull()
  })
})
