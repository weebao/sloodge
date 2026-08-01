/**
 * DrawingML → contract HTML (M4.5).
 *
 * Two things are being asserted throughout: that the mapping is *right* (geometry, colour, text), and
 * that the output is *admissible* — every generated document must satisfy the Tier-1 contract, since
 * the sandboxed iframe, the export renderer and Design Mode are all entitled to assume it.
 */

import { describe, expect, it } from 'vitest'
import { convertSlide } from '../../../src/shared/import/pptx/convert'
import {
  FALLBACK_THEME,
  readTheme,
  resolveSchemeColor,
  themeTokens,
} from '../../../src/shared/import/pptx/theme'
import { parseXml } from '../../../src/shared/import/xml'
import { validateSlideContract } from '../../../src/shared/document/slide-contract'
import { DEFAULT_THEME_TOKENS } from '../../../src/shared/document/starter-slide'
import type { OpcRelationships } from '../../../src/shared/import/pptx/opc'

const SLIDE_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'
const SIZE_16_9 = { widthEmu: 12_192_000, heightEmu: 6_858_000 }
const TOKENS = themeTokens(FALLBACK_THEME, DEFAULT_THEME_TOKENS)

const NO_RELS: OpcRelationships = {
  bySourcePart: 'ppt/slides/slide1.xml',
  all: [],
  byId: Object.create(null) as Record<string, never>,
}

function convert(
  spTreeXml: string,
  options: { relationships?: OpcRelationships; media?: (part: string) => string | null } = {},
) {
  return convertSlide({
    slideId: SLIDE_ID,
    slide: parseXml(`<p:sld><p:cSld><p:spTree>${spTreeXml}</p:spTree></p:cSld></p:sld>`),
    relationships: options.relationships ?? NO_RELS,
    media: options.media ?? (() => null),
    theme: FALLBACK_THEME,
    size: SIZE_16_9,
    tokens: TOKENS,
  })
}

/** A shape with explicit geometry, in EMU. 12192000 EMU wide = 1280 px, so 9525 EMU = 1 px. */
function shape(inner: string, x = 0, y = 0, cx = 1_219_200, cy = 685_800): string {
  return `<p:sp><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr>${inner}</p:sp>`
}

function textBody(runs: string, bodyPr = '<a:bodyPr/>'): string {
  return `<p:txBody>${bodyPr}<a:p>${runs}</a:p></p:txBody>`
}

describe('contract compliance', () => {
  it('every generated document satisfies the Tier-1 contract', () => {
    const documents = [
      convert(shape(textBody('<a:r><a:t>Hello</a:t></a:r>'))).html,
      convert('').html,
      convert(shape('', 0, 0, 100, 100)).html,
      convert(shape(textBody('<a:r><a:rPr sz="4000" b="1" i="1" u="sng"/><a:t>Styled</a:t></a:r>')))
        .html,
      convert(
        '<p:graphicFrame><a:graphic><a:graphicData uri="x/table"><a:t>cell</a:t></a:graphicData></a:graphic></p:graphicFrame>',
      ).html,
    ]
    for (const html of documents) {
      const result = validateSlideContract(html, ['static'])
      expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      expect(result.ok).toBe(true)
    }
  })

  it('escapes text that would otherwise inject markup', () => {
    const hostile = '</div></body><script>fetch("https://evil.example")</script>'
    const result = convert(
      shape(textBody(`<a:r><a:t>${hostile.replaceAll('<', '&lt;')}</a:t></a:r>`)),
    )
    expect(result.html).not.toContain('<script>')
    expect(result.html).toContain('&lt;script&gt;')
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
  })

  it('imports a slide whose prose contains SL-S04 API names', () => {
    // A deck about JavaScript is a real deck. Before the defusing pass, the contract's whole-source
    // token scan rejected this text, the text-only fallback failed for the same reason, and the
    // import died with `unconvertible`.
    const prose = 'Use fetch() instead of XMLHttpRequest; avoid localStorage and eval()'
    const result = convert(shape(textBody(`<a:r><a:t>${prose}</a:t></a:r>`)))
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
    // The bytes are unmatchable...
    expect(result.html).not.toContain('fetch(')
    expect(result.html).not.toContain('localStorage')
    // ...and the text still reads correctly once entities are resolved.
    expect(result.html).toContain('&#102;etch(')
    expect(
      result.html.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code))),
    ).toContain(prose)
  })

  it('defuses a token even when it is split by whitespace, as the scan packs it', () => {
    // The validator strips whitespace before matching, so "local storage" packs to "localstorage".
    const result = convert(
      shape(textBody('<a:r><a:t>local storage and new Function()</a:t></a:r>')),
    )
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
  })

  it('leaves ordinary text untouched', () => {
    const html = convert(
      shape(textBody('<a:r><a:t>Revenue up 18% year over year</a:t></a:r>')),
    ).html
    expect(html).toContain('Revenue up 18% year over year')
  })

  it('emits exactly one .slide root at 1280x720', () => {
    const html = convert(shape(textBody('<a:r><a:t>x</a:t></a:r>'))).html
    expect(html.match(/class="slide"/g)).toHaveLength(1)
    expect(html).toContain('width: 1280px')
    expect(html).toContain('height: 720px')
  })
})

describe('geometry', () => {
  it('scales EMU to px against the slide width', () => {
    // 1219200 EMU = one tenth of a 12192000-wide slide = 128 px.
    const html = convert(shape(textBody('<a:r><a:t>x</a:t></a:r>'), 609_600, 342_900)).html
    expect(html).toContain('left:64px')
    expect(html).toContain('top:36px')
    expect(html).toContain('width:128px')
    expect(html).toContain('height:72px')
  })

  it('letterboxes a 4:3 source rather than stretching it', () => {
    const result = convertSlide({
      slideId: SLIDE_ID,
      slide: parseXml(
        `<p:sld><p:cSld><p:spTree>${shape(textBody('<a:r><a:t>x</a:t></a:r>'), 0, 0, 9_144_000, 6_858_000)}</p:spTree></p:cSld></p:sld>`,
      ),
      relationships: NO_RELS,
      media: () => null,
      theme: FALLBACK_THEME,
      size: { widthEmu: 9_144_000, heightEmu: 6_858_000 },
      tokens: TOKENS,
    })
    // 720/6858000 is the binding scale; the 960px-wide result is centred, leaving 160px bars.
    expect(result.html).toContain('left:160px')
    expect(result.html).toContain('width:960px')
    expect(result.notes.join(' ')).toContain('not 16:9')
  })

  it('does not warn about aspect ratio for a rounding-inexact 16:9 slide', () => {
    // `Inches(13.333)` rounds to 12192019 EMU, not 12192000 — an exact comparison would mislabel
    // every python-pptx and PowerPoint "Widescreen" deck.
    const result = convertSlide({
      slideId: SLIDE_ID,
      slide: parseXml('<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>'),
      relationships: NO_RELS,
      media: () => null,
      theme: FALLBACK_THEME,
      size: { widthEmu: 12_192_019, heightEmu: 6_858_000 },
      tokens: TOKENS,
    })
    expect(result.notes.join(' ')).not.toContain('not 16:9')
  })

  it('applies a group child-offset transform to nested shapes', () => {
    const grouped = `<p:grpSp><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/><a:chOff x="609600" y="342900"/><a:chExt cx="1219200" cy="685800"/></a:xfrm></p:grpSpPr>${shape(textBody('<a:r><a:t>x</a:t></a:r>'), 609_600, 342_900)}</p:grpSp>`
    // The child sits at the group's chOff, so after the shift it lands at the group's origin.
    expect(convert(grouped).html).toContain('left:0px')
  })

  it('clamps a negative extent instead of inverting the box', () => {
    expect(convert(shape(textBody('<a:r><a:t>x</a:t></a:r>'), 0, 0, -100, -100)).html).toContain(
      'width:0px',
    )
  })

  it('stops recursing past 32 nested groups', () => {
    const open = '<p:grpSp><p:grpSpPr/>'.repeat(40)
    const close = '</p:grpSp>'.repeat(40)
    const result = convert(`${open}${shape(textBody('<a:r><a:t>deep</a:t></a:r>'))}${close}`)
    expect(result.notes.join(' ')).toContain('nests deeper than 32')
  })
})

describe('text', () => {
  it('carries run size, weight, style, decoration and colour', () => {
    const html = convert(
      shape(
        textBody(
          '<a:r><a:rPr sz="4000" b="1" i="1" u="sng"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>Styled</a:t></a:r>',
        ),
      ),
    ).html
    expect(html).toContain('font-size:53.33px') // 40pt at 96 px/inch (1280px / 13.333in)
    expect(html).toContain('font-weight:700')
    expect(html).toContain('font-style:italic')
    expect(html).toContain('text-decoration:underline')
    expect(html).toContain('color:#ff0000')
  })

  it('records the source typeface without applying it (SL-S03 permits the system stack only)', () => {
    const html = convert(
      shape(textBody('<a:r><a:rPr><a:latin typeface="Comic Sans MS"/></a:rPr><a:t>x</a:t></a:r>')),
    ).html
    expect(html).toContain('data-sl-pptx-font="Comic Sans MS"')
    expect(html).not.toContain('font-family:Comic Sans MS')
    expect(html).not.toContain('@font-face')
  })

  it('numbers every text run in document order for provenance', () => {
    const result = convert(
      shape(
        textBody(
          '<a:r><a:t>one</a:t></a:r><a:r><a:t>two</a:t></a:r><a:fld id="x"><a:t>three</a:t></a:fld>',
        ),
      ),
    )
    expect(result.runCount).toBe(3)
    expect(result.html).toContain('data-sl-run="0"')
    expect(result.html).toContain('data-sl-run="1"')
    expect(result.html).toContain('data-sl-run="2"')
  })

  it('renders explicit line breaks and paragraph alignment', () => {
    const html = convert(
      shape(
        `<p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:r><a:t>a</a:t></a:r><a:br/><a:r><a:t>b</a:t></a:r></a:p></p:txBody>`,
      ),
    ).html
    expect(html).toContain('text-align:center')
    expect(html).toContain('<br>')
  })

  it('adds a bullet glyph without consuming a run index', () => {
    const result = convert(
      shape(
        `<p:txBody><a:bodyPr/><a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:t>point</a:t></a:r></a:p></p:txBody>`,
      ),
    )
    expect(result.html).toContain('sl-bullet')
    expect(result.html).toContain('padding-left:28px')
    expect(result.runCount).toBe(1)
    expect(result.html).toContain('data-sl-run="0"')
  })

  it('honours buNone', () => {
    const html = convert(
      shape(
        `<p:txBody><a:bodyPr/><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>x</a:t></a:r></a:p></p:txBody>`,
      ),
    ).html
    expect(html).not.toContain('<span class="sl-bullet">')
  })

  it('sizes an unstyled placeholder by its type, recovering the hierarchy', () => {
    const ph = (type: string): string =>
      `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr>${textBody('<a:r><a:t>x</a:t></a:r>')}</p:sp>`
    // A flat default would render a title at body size and the slide would read as a wall of text.
    expect(convert(ph('title')).html).toContain('font-size:53.33px') // 40pt
    expect(convert(ph('body')).html).toContain('font-size:26.67px') // 20pt
    expect(convert(ph('sldNum')).html).toContain('font-size:16px') // 12pt
  })

  it('clamps a corrupt font size instead of rendering invisible or enormous text', () => {
    expect(convert(shape(textBody('<a:r><a:rPr sz="0"/><a:t>x</a:t></a:r>'))).html).toContain(
      'font-size:1.33px',
    )
    expect(convert(shape(textBody('<a:r><a:rPr sz="9999999"/><a:t>x</a:t></a:r>'))).html).toContain(
      'font-size:533.33px',
    )
  })

  it('uses the first non-empty run as the slide title', () => {
    expect(
      convert(shape(textBody('<a:r><a:t>  </a:t></a:r><a:r><a:t>Real title</a:t></a:r>'))).title,
    ).toBe('Real title')
    expect(convert('').title).toBe('Slide')
  })
})

describe('colour and theme', () => {
  it('maps the four tokenised scheme slots to CSS custom properties', () => {
    const fill = (slot: string): string =>
      convert(
        `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:solidFill><a:schemeClr val="${slot}"/></a:solidFill></p:spPr></p:sp>`,
      ).html
    expect(fill('accent1')).toContain('background:var(--sl-accent)')
    expect(fill('lt1')).toContain('background:var(--sl-bg)')
    expect(fill('tx1')).toContain('background:var(--sl-fg)')
    expect(fill('dk2')).toContain('background:var(--sl-muted)')
    // An untokenised slot resolves to a literal so the colour is not lost.
    expect(fill('accent4')).toContain('background:#ffc000')
  })

  it('reads a theme colour scheme, including sysClr lastClr', () => {
    const theme = readTheme(
      parseXml(
        `<a:theme><a:themeElements><a:clrScheme><a:dk1><a:sysClr val="windowText" lastClr="121212"/></a:dk1><a:lt1><a:srgbClr val="FEFEFE"/></a:lt1><a:accent1><a:srgbClr val="AABBCC"/></a:accent1></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
      ),
    )
    expect(theme.colors['dk1']).toBe('#121212')
    expect(theme.colors['lt1']).toBe('#fefefe')
    expect(theme.colors['accent1']).toBe('#aabbcc')
    expect(theme.majorFont).toBe('Georgia')
    expect(theme.minorFont).toBe('Verdana')
    // Slots the file omits fall back rather than becoming undefined.
    expect(theme.colors['accent6']).toBe('#70ad47')
  })

  it('maps slide-level colour names through the default colour map', () => {
    expect(resolveSchemeColor(FALLBACK_THEME, 'bg1')).toBe('#ffffff')
    expect(resolveSchemeColor(FALLBACK_THEME, 'tx1')).toBe('#000000')
    expect(resolveSchemeColor(FALLBACK_THEME, 'nonsense')).toBeNull()
  })

  it('derives tokens whose values are safe to inline into a <style> block', () => {
    const hostile = readTheme(
      parseXml(
        `<a:theme><a:clrScheme><a:lt1><a:srgbClr val="url(//evil)"/></a:lt1></a:clrScheme></a:theme>`,
      ),
    )
    // The hex test rejects it long before it could reach CSS.
    expect(hostile.colors['lt1']).toBe('#ffffff')
    expect(themeTokens(hostile, DEFAULT_THEME_TOKENS)['--sl-bg']).toBe('#ffffff')
  })

  it('rejects a control-character typeface name', () => {
    const theme = readTheme(
      parseXml(
        `<a:theme><a:fontScheme><a:majorFont><a:latin typeface="a&#9;b"/></a:majorFont></a:fontScheme></a:theme>`,
      ),
    )
    expect(theme.majorFont).toBeNull()
  })
})

/** A `p:pic` with explicit geometry, referencing the given relationship id. */
function pic(embed: string): string {
  return `<p:pic><p:blipFill><a:blip r:embed="${embed}"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr></p:pic>`
}

describe('pictures', () => {
  const relationships: OpcRelationships = {
    bySourcePart: 'ppt/slides/slide1.xml',
    all: [],
    byId: Object.assign(Object.create(null) as Record<string, unknown>, {
      rId2: {
        id: 'rId2',
        type: 'image',
        target: '../media/image1.png',
        external: false,
        resolved: 'ppt/media/image1.png',
      },
      rIdExt: {
        id: 'rIdExt',
        type: 'image',
        target: 'https://evil.example/x.png',
        external: true,
        resolved: null,
      },
    }) as OpcRelationships['byId'],
  }

  it('inlines an embedded image as a data: URI', () => {
    const result = convert(pic('rId2'), {
      relationships,
      media: () => 'data:image/png;base64,AAAA',
    })
    expect(result.html).toContain('src="data:image/png;base64,AAAA"')
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
  })

  it('drops an external picture link rather than fetching it', () => {
    const result = convert(pic('rIdExt'), { relationships, media: () => 'data:image/png;base64,X' })
    expect(result.html).not.toContain('evil.example')
    expect(result.notes.join(' ')).toContain('external link')
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
  })

  it('falls back to a placeholder box when the image cannot be inlined', () => {
    const result = convert(pic('rId2'), { relationships, media: () => null })
    expect(result.html).toContain('sl-missing-image')
    expect(result.notes.join(' ')).toContain('could not be inlined')
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
  })

  it('notes an unknown relationship id', () => {
    const result = convert(pic('rIdNope'), { relationships })
    expect(result.notes.join(' ')).toContain('unknown relationship rIdNope')
  })
})

describe('fallbacks are reported, not silent', () => {
  it('converts a graphic frame to a text placeholder and says so', () => {
    const result = convert(
      '<p:graphicFrame><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:graphicData></a:graphic></p:graphicFrame>',
    )
    expect(result.notes.join(' ')).toContain('graphic frame (table)')
    expect(result.html).toContain('cell')
    // Table text still gets run markers, so an edit inside a cell stays patchable.
    expect(result.html).toContain('data-sl-run="0"')
  })

  it('notes gradient and picture fills it flattened', () => {
    expect(convert('<p:sp><p:spPr><a:gradFill/></p:spPr></p:sp>').notes.join(' ')).toContain(
      'gradient fill flattened',
    )
    expect(convert('<p:sp><p:spPr><a:blipFill/></p:spPr></p:sp>').notes.join(' ')).toContain(
      'picture fill on a shape',
    )
  })

  it('notes a connector it rendered as a plain box', () => {
    expect(
      convert(
        '<p:cxnSp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:cxnSp>',
      ).notes.join(' '),
    ).toContain('connector rendered as a plain box')
  })

  it('notes a slide with no shape tree', () => {
    const result = convertSlide({
      slideId: SLIDE_ID,
      slide: parseXml('<p:sld/>'),
      relationships: NO_RELS,
      media: () => null,
      theme: FALLBACK_THEME,
      size: SIZE_16_9,
      tokens: TOKENS,
    })
    expect(result.notes.join(' ')).toContain('no shape tree')
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
  })

  it('skips a shape with nothing visible rather than emitting an empty box', () => {
    expect(convert('<p:sp><p:spPr/></p:sp>').html).not.toContain('sl-shape')
  })
})
