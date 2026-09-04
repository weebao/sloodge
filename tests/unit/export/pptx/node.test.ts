import { describe, expect, it } from 'vitest'
import { slideMeasurementScript } from '../../../../src/shared/export/pptx/node'
import { MODELLED_PROPERTIES } from '../../../../src/shared/export/pptx/properties'

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

  it('reads all four transform properties, not just the matrix', () => {
    // The standalone `rotate:`/`scale:`/`translate:` do not fold into the computed `transform`, so
    // reading `transform` alone shipped a rotated element upright at rot=0 (review r2, §1.3(b)).
    expect(src).toContain('cs.rotate')
    expect(src).toContain('cs.scale')
    expect(src).toContain('cs.translate')
  })

  it('censuses every computed property against the modelled set, not a deny-list', () => {
    // The closed world: enumerate what Chromium computed, subtract what `properties.ts` claims, and
    // report the rest by name. Deleting the census leaves the scorer unable to see any construct
    // nobody thought to add — the failure two review rounds found at successive layers.
    expect(src).toContain('censusOf')
    expect(src).toContain('unmodelledProperties')
    for (const modelled of MODELLED_PROPERTIES.slice(0, 3)) expect(src).toContain(modelled)
    // The baseline is a real per-tag probe under the UA stylesheet, inside a shadow root so author
    // CSS cannot mask the very signal being looked for.
    expect(src).toContain('attachShadow')
    expect(src).toContain('baselineFor')
  })

  it('measures the text a leaf clips from itself, which no descendant walk can see', () => {
    expect(src).toContain('scrollWidth')
    expect(src).toContain('scrollHeight')
    expect(src).toContain('clippedTextPx')
  })
})
