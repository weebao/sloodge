import { describe, expect, it } from 'vitest'
import { slideMeasurementScript } from '../../../../src/shared/export/pptx/node'

/**
 * The measurement pass runs in a browser (asserted end-to-end by the harness), so the unit test pins
 * the properties a string *can* pin: it applies the visibility filter, the leaf-text rule, reads the
 * style subset the walker needs, and reports the body background plus an animation flag.
 */
describe('slideMeasurementScript', () => {
  const src = slideMeasurementScript()

  it('is a self-invoking expression returning nodes + body + hasAnimation', () => {
    expect(src.startsWith('(() =>')).toBe(true)
    expect(src).toContain('nodes')
    expect(src).toContain('body')
    expect(src).toContain('hasAnimation')
  })

  it('applies the visibility filter and the leaf-text rule', () => {
    expect(src).toContain("cs.display !== 'none'")
    expect(src).toContain("cs.visibility !== 'hidden'")
    expect(src).toContain('el.children.length === 0')
  })

  it('reads the style subset the walker and scorer consume', () => {
    for (const key of [
      'fontSize',
      'backgroundImage',
      'boxShadow',
      'filter',
      'clipPath',
      'transform',
      'writingMode',
    ]) {
      expect(src).toContain(key)
    }
  })
})
