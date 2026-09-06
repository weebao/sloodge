import { describe, expect, it } from 'vitest'
import { slideMeasurementScript } from '../../../../src/shared/export/pptx/node'
import {
  LAYOUT_RESOLVED_PROPERTIES,
  MODELLED_PROPERTIES,
  VALUE_SCOPED_EXEMPTIONS,
} from '../../../../src/shared/export/pptx/properties'

/**
 * The measurement pass runs in a browser (asserted end-to-end by the harness), so the unit test pins
 * the properties a string *can* pin: it applies the visibility filter, the leaf-text rule, reads the
 * style subset the walker needs, and reports the body background plus an animation flag.
 */
describe('slideMeasurementScript', () => {
  const src = slideMeasurementScript()

  it('parses as JavaScript', () => {
    // The script is a template literal, so a regex character class written with single
    // backslashes (`\\t\\n`) reaches the slide as a literal newline inside `[...]` — a SyntaxError
    // that `runInSlide` turns into `EMPTY_MEASURE`, i.e. every slide measuring no text at score
    // 100. That happened once in M4.8b and cost a harness run to see; this costs milliseconds.
    // eslint-disable-next-line no-new-func
    expect(() => new Function(`return ${src}`)).not.toThrow()
  })

  it('is a self-invoking expression returning nodes + body + hasAnimation', () => {
    expect(src.startsWith('(() =>')).toBe(true)
    expect(src).toContain('nodes')
    expect(src).toContain('body')
    expect(src).toContain('hasAnimation')
  })

  it('applies the visibility filter and the block-root text rule', () => {
    expect(src).toContain("cs.display !== 'none'")
    // `=== 'visible'`, not `!== 'hidden'`: `visibility: collapse` paints nothing on a non-table
    // element, so the loose test let the exporter invent a banner nobody could see (review r3).
    expect(src).toContain("cs.visibility === 'visible'")
    expect(src).not.toContain("cs.visibility !== 'hidden'")
    // Text belongs to the nearest non-inline ancestor, one item per text node (M4.8b); the leaf
    // rule survives only for SVG, whose `<text>`/`<tspan>` have no CSS block structure.
    expect(src).toContain('collectInline')
    expect(src).toContain('blockRootOf')
    expect(src).toContain("cs.display === 'inline'")
    expect(src).toContain('inlineOf')
    expect(src).toContain('el.children.length === 0')
  })

  it("records raw text with its parent's white-space mode and propagated decoration (M4.8b)", () => {
    expect(src).toContain('whiteSpaceCollapse')
    expect(src).toContain('decorationChain')
    // `<br>` is a hard break; an atomic inline, a float and a hidden inline are flow holes.
    expect(src).toContain("kind: 'br'")
    expect(src).toContain("cs.float !== 'none'")
    expect(src).toContain('bulletedLis')
  })

  it('censuses the two root elements, which querySelectorAll cannot reach', () => {
    // `body.querySelectorAll('*')` yields neither <body> nor <html>, so a paint property on either
    // was measured by nothing and scored by nothing — an inverted deck at score 100 (review r3).
    expect(src).toContain('rootPaint')
    expect(src).toContain('rootPaint(document.body)')
    expect(src).toContain('rootPaint(document.documentElement)')
  })

  it("holds the census baseline two shadow roots deep, out of author CSS's reach", () => {
    // One root is not enough: author CSS cannot style inside a shadow tree but CAN style the host,
    // and an `!important` declaration there beats the host's inline `all: initial`, so the baseline
    // became the very value under test. The inner host is itself inside a shadow tree (review r3).
    expect(src).toContain('probeOuter.attachShadow')
    expect(src).toContain('probeHost.attachShadow')
  })

  it('treats containment as clipping and a replaced `content` as replacing', () => {
    // Two `LAYOUT_RESOLVED_PROPERTIES` entries whose written justification was false: `contain:
    // paint` clips while leaving computed `overflow` at `visible`, and `content: url()` renders an
    // image instead of the children the exporter was shipping as text (review r3).
    expect(src).toContain('clipsByContain')
    expect(src).toContain('contentReplaced')
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
    expect(src).toContain(JSON.stringify(MODELLED_PROPERTIES))
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

  it('scopes the view-transition-name exemption to one value on the document element', () => {
    // The property creates a stacking context, so it cannot be exempted outright; but Chromium's UA
    // sheet names <html> `root` and the census baseline (a detached <html> two shadow roots deep,
    // which is not THE root) computes `none`, so every slide reported it (review r4).
    expect(src).toContain(JSON.stringify(VALUE_SCOPED_EXEMPTIONS))
    expect(src).toContain('valueScoped')
    expect(src).toContain('el === document.documentElement')
  })
})

/**
 * The rule `properties.ts` states, enforced rather than described: **a property that establishes a
 * stacking context can never be layout-resolved**, because the measurement pass records rects and
 * colours and nothing about paint order, so such an entry is unfalsifiable from the recording alone.
 *
 * The list below is CSS's own set of stacking-context creators. `will-change` and
 * `view-transition-name` were both in `LAYOUT_RESOLVED_PROPERTIES` until r4, and a slide using
 * either exported a `z-index: -1` child on the wrong side of its parent at score 100 with an empty
 * loss list. Adding any of these back reds this test.
 */
describe('the stacking-context rule', () => {
  const STACKING_CONTEXT_PROPERTIES = [
    'backdrop-filter',
    'clip-path',
    'contain',
    'container-type',
    'content-visibility',
    'filter',
    'isolation',
    'mask',
    'mask-border',
    'mask-image',
    'mix-blend-mode',
    'offset-path',
    'opacity',
    'perspective',
    'position',
    'rotate',
    'scale',
    'transform',
    'translate',
    'view-transition-name',
    'will-change',
    'z-index',
  ]

  it('exempts none of them', () => {
    const exempted = STACKING_CONTEXT_PROPERTIES.filter((p) =>
      LAYOUT_RESOLVED_PROPERTIES.includes(p),
    )
    // `container-type` is on the list because CSS Contain says it applies layout containment, which
    // does create one. Chromium disagrees — it computes `contain: none` for `container-type:
    // inline-size` and leaves paint order alone — so it is exempted, and is the one entry here whose
    // safety rests on a measurement rather than on the spec. Kept in the list so that a Chromium
    // that changes its mind reds this rather than shipping silently.
    expect(exempted).toEqual(['container-type'])
  })

  it('value-scopes the one that cannot simply be dropped', () => {
    expect(VALUE_SCOPED_EXEMPTIONS).toEqual([
      { property: 'view-transition-name', value: 'root', documentElementOnly: true },
    ])
    for (const e of VALUE_SCOPED_EXEMPTIONS) {
      expect(MODELLED_PROPERTIES).not.toContain(e.property)
      expect(LAYOUT_RESOLVED_PROPERTIES).not.toContain(e.property)
    }
  })
})
