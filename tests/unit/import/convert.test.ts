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
import {
  FORBIDDEN_API_TOKENS,
  packForApiScan,
  validateSlideContract,
} from '../../../src/shared/document/slide-contract'
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

  /**
   * The regression that review round 1 caught, generalised so it cannot recur for any token.
   *
   * The original defuser restated SL-S04's normalisation by hand and got it wrong for exactly one
   * token: `new Function(` was split on characters and joined with `\s*`, leaving the interior space
   * *required*. The validator strips all whitespace, so it matched `newFunction(` and the defuser did
   * not — and that spelling took a whole deck's import down with `unconvertible`. The old test used
   * the spaced spelling, so the suite was green over the hole.
   *
   * This iterates `FORBIDDEN_API_TOKENS` itself, so a token added to the rule later is covered
   * without anyone remembering, and it generates every spelling `packForApiScan` folds together —
   * which is the definition of "what the validator will catch".
   */
  it('defuses every spelling of every forbidden token at every archive-supplied emission site', () => {
    expect(FORBIDDEN_API_TOKENS.length).toBeGreaterThan(10)

    /**
     * Every place archive-controlled text reaches the slide document *through the converter*.
     * Round 2 found the typeface attribute still spelled `escapeHtml` while the text node used
     * `slideText`; round 3 found a site this table could never drive — the `.potx` starter slide,
     * built by `starter-slide.ts`. So this table is the behavioural half only: it proves each row
     * defuses. The exhaustiveness question — is every emission site *in* some table — is answered
     * structurally by `slide-text-boundary.test.ts`, which reads every producer's `escapeHtml(`
     * calls off the source; the starter slide has its own rows in `starter-slide.test.ts`.
     */
    const sites: { name: string; build: (spelling: string) => string }[] = [
      {
        name: 'text run',
        build: (spelling) =>
          shape(textBody(`<a:r><a:t>Avoid ${spelling} in modern code</a:t></a:r>`)),
      },
      {
        name: 'typeface attribute',
        build: (spelling) =>
          shape(
            textBody(
              `<a:r><a:rPr><a:latin typeface="${spelling}"/></a:rPr><a:t>styled</a:t></a:r>`,
            ),
          ),
      },
      {
        name: 'slide title (first run, echoed into <title>)',
        build: (spelling) => shape(textBody(`<a:r><a:t>${spelling}</a:t></a:r>`)),
      },
    ]

    for (const token of FORBIDDEN_API_TOKENS) {
      const packed = packForApiScan(token)
      const spellings = [
        token, // as written in the rule
        packed, // all whitespace removed — the spelling that used to slip through
        token.toUpperCase(),
        token.replace(/ /g, '\t'), // tab instead of space
        token.replace(/ /g, '\n'), // newline instead of space
        packed.split('').join(' '), // whitespace injected between every character
      ]

      for (const spelling of spellings) {
        // Sanity: every spelling really is one the validator would flag, so a passing assertion
        // below means the defuser worked rather than that the input was harmless.
        expect(packForApiScan(spelling)).toContain(packed)

        for (const site of sites) {
          // A typeface is capped at 128 chars and dropped if longer; every spelling here is short.
          const result = convert(site.build(spelling))
          const errors = validateSlideContract(result.html, ['static']).issues.filter(
            (issue) => issue.severity === 'error',
          )
          expect(
            errors,
            `${site.name}: token ${JSON.stringify(token)} spelled ${JSON.stringify(spelling)}`,
          ).toEqual([])
        }
      }
    }
  })

  /**
   * Review round 5: the defuser matched with the RegExp `i` flag, the validator folds with
   * `toLowerCase()`, and they disagree on U+212A KELVIN SIGN — `WebSoc\u212Aet` passed the defuser
   * and failed the gate, in the run, the fallback and the `.potx` title alike. The matcher now comes
   * from `slide-contract.ts`; this drives every token through every letter whose case fold is
   * special, at every emission site, and checks both halves of the agreement: prose imports clean,
   * and the same spelling inside a `<script>` is still caught by the rule.
   */
  it('agrees with the validator on Unicode case folds, at every emission site', () => {
    const folds: readonly [letter: string, special: string][] = [
      ['k', '\u212A'],
      ['s', '\u017F'],
      ['i', '\u0130'],
    ]
    const sites = [
      (spelling: string) => shape(textBody(`<a:r><a:t>Try ${spelling} today</a:t></a:r>`)),
      (spelling: string) =>
        shape(
          textBody(`<a:r><a:rPr><a:latin typeface="${spelling}"/></a:rPr><a:t>styled</a:t></a:r>`),
        ),
      (spelling: string) => shape(textBody(`<a:r><a:t>${spelling}</a:t></a:r>`)),
    ]
    const variants: readonly [letter: string, special: string][] = [['', ''], ...folds]
    let caught = 0
    for (const token of FORBIDDEN_API_TOKENS) {
      const packed = packForApiScan(token)
      for (const [letter, special] of variants) {
        const spelling = letter === '' ? token : token.replaceAll(letter, special)
        for (const site of sites) {
          const errors = validateSlideContract(convert(site(spelling)).html, ['static']).issues
          expect(
            errors.filter((issue) => issue.severity === 'error'),
            spelling,
          ).toEqual([])
        }
        // The rule itself is untouched: raw inside a script, the spelling is caught exactly when
        // the validator's own normalisation says it is a token.
        const flagged = packForApiScan(spelling).includes(packed)
        const script = `<!doctype html><html><body><script>${spelling}</script></body></html>`
        const rules = validateSlideContract(script, ['static']).issues.map((issue) => issue.rule)
        expect(rules.includes('SL-S04'), spelling).toBe(flagged)
        if (flagged) caught += 1
      }
    }
    expect(caught).toBeGreaterThan(FORBIDDEN_API_TOKENS.length)
  })

  it('still records the defused typeface, so provenance survives the escaping', () => {
    const result = convert(
      shape(textBody('<a:r><a:rPr><a:latin typeface="localStorage"/></a:rPr><a:t>x</a:t></a:r>')),
    )
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
    expect(result.html).not.toContain('data-sl-pptx-font="localStorage"')
    // The attribute is still there and still reads back as the original name once entities resolve.
    expect(
      result.html.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code))),
    ).toContain('data-sl-pptx-font="localStorage"')
  })

  it('imports a deck whose prose reads "newFunction(" — the exact round-1 blocker', async () => {
    // End to end through the shipped path, not just the converter: this spelling previously failed
    // conversion, failed the text-only fallback for the same reason, and failed the whole import.
    const result = convert(
      shape(textBody('<a:r><a:t>Avoid newFunction( in modern JavaScript</a:t></a:r>')),
    )
    expect(validateSlideContract(result.html, ['static']).ok).toBe(true)
    expect(
      result.html.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code))),
    ).toContain('Avoid newFunction( in modern JavaScript')
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

  /**
   * Review round 1's major: `tokenBlock` and the importer's fallback each carried a hand-copied,
   * *weakened* version of `THEME_TOKEN_VALUE_FORBIDDEN` — both had dropped the `\p{Cc}` clause and
   * the length cap — and silently dropped a failing token, which leaves `background: var(--sl-bg)`
   * unresolvable and renders the slide transparent. Both copies are gone; the canonical
   * `assertSafeThemeToken` now guards, and a failure substitutes the built-in default.
   */
  it('substitutes rather than drops a token value the canonical guard rejects', () => {
    const hostile = {
      ...DEFAULT_THEME_TOKENS,
      // A newline: legal-looking, and specifically what the weakened copies let through. It shifts
      // the line count between the `sl:theme` sentinels that byte-range retheming keys off.
      '--sl-bg': '#fff\n  ;background:url(//evil.example/beacon.png)',
      '--sl-muted': 'x'.repeat(500), // over MAX_THEME_TOKEN_VALUE_LENGTH
    }
    const tokens = themeTokens(FALLBACK_THEME, hostile)

    // Never dropped — an absent declaration is a rendering failure, not a safe default.
    expect(tokens['--sl-bg']).toBeDefined()
    expect(tokens['--sl-muted']).toBeDefined()
    expect(tokens['--sl-bg']).not.toContain('evil.example')
    expect(tokens['--sl-bg']).not.toContain('\n')

    const html = convertSlide({
      slideId: SLIDE_ID,
      slide: parseXml('<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>'),
      relationships: NO_RELS,
      media: () => null,
      theme: FALLBACK_THEME,
      size: SIZE_16_9,
      tokens,
    }).html

    expect(html).not.toContain('evil.example')
    // Every `--sl-*` the slide's CSS references still resolves.
    for (const name of ['--sl-bg', '--sl-fg', '--sl-font']) {
      expect(html).toContain(`${name}:`)
    }
    expect(validateSlideContract(html, ['static']).ok).toBe(true)
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
    expect(result.notes.join(' ')).toContain('unknown relationship "rIdNope"')
  })

  it('bounds and quotes the archive string a note repeats', () => {
    const result = convert(pic(`${'x'.repeat(5000)}&#10;tail`), { relationships })
    const note = result.notes.find((n) => n.includes('unknown relationship'))!
    expect(note.length).toBeLessThan(200)
    expect(note).toContain(`"${'x'.repeat(80)}"`)
    expect(convert(pic('a&#10;b'), { relationships }).notes.join(' ')).not.toContain('\n')
  })
})

/**
 * Review round 5: `px()` wrote whatever arithmetic over archive integers produced. A zero-extent
 * group scaled its children by 0 and a 300-digit child offset pushed the shift to infinity, so a
 * position became `NaN` — `left:NaNpx`, a declaration the browser drops, and the shape rendered at
 * auto position with no note. Every emitted length is now finite and bounded.
 */
function group(xfrm: string, inner: string): string {
  return `<p:grpSp><p:grpSpPr><a:xfrm>${xfrm}</a:xfrm></p:grpSpPr>${inner}</p:grpSp>`
}

/** Every px length in the document, having first refused the two spellings CSS drops. */
function lengths(html: string): number[] {
  expect(html).not.toMatch(/NaN|Infinity/)
  return [...html.matchAll(/:(-?[\d.]+(?:e[+-]?\d+)?)px/g)].map((m) => Number(m[1]))
}

describe('geometry stays finite on absurd input', () => {
  const huge = '1'.repeat(300)
  const leaf = shape(textBody('<a:r><a:t>x</a:t></a:r>'), 5, 5)

  it('a tiny group scale that overflows the child shift', () => {
    const html = convert(
      group(
        `<a:off x="${huge}" y="0"/><a:ext cx="1" cy="1"/><a:chOff x="0" y="0"/><a:chExt cx="${huge}" cy="1"/>`,
        leaf,
      ),
    ).html
    for (const value of lengths(html)) expect(Math.abs(value)).toBeLessThanOrEqual(100_000)
    expect(validateSlideContract(html, ['static']).ok).toBe(true)
  })

  it('a zero-extent group around an overflowing one (NaN)', () => {
    const html = convert(
      group(
        '<a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="1" cy="1"/>',
        group(
          `<a:off x="${huge}" y="0"/><a:ext cx="1" cy="1"/><a:chOff x="0" y="0"/><a:chExt cx="${huge}" cy="1"/>`,
          leaf,
        ),
      ),
    ).html
    for (const value of lengths(html)) expect(Math.abs(value)).toBeLessThanOrEqual(100_000)
  })

  it('clamps a paragraph level to the schema range instead of overflowing the indent', () => {
    const html = convert(shape(textBody(`<a:pPr lvl="${huge}"/><a:r><a:t>deep</a:t></a:r>`))).html
    expect(html).toContain('padding-left:224px')
    expect(convert(shape(textBody('<a:pPr lvl="3"/><a:r><a:t>t</a:t></a:r>'))).html).toContain(
      'padding-left:84px',
    )
  })
})

describe('fallbacks are reported, not silent', () => {
  it('converts a graphic frame to a text placeholder and says so', () => {
    const result = convert(
      '<p:graphicFrame><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:graphicData></a:graphic></p:graphicFrame>',
    )
    expect(result.notes.join(' ')).toContain('graphic frame ("table")')
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
