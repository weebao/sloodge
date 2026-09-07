import { describe, expect, it } from 'vitest'

import {
  GENERIC_FAMILY_WORDS,
  MAX_FONT_FAMILY_NAME_LENGTH,
  MAX_SYSTEM_FONT_FAMILIES,
  SYSTEM_FONT_GROUP,
  buildFontFamilyValue,
  cssIdentFontFamily,
  isContractSafeFontFamilyName,
  isSystemGroupFamily,
  isValidFontFamilyName,
  normalizeFontFamilies,
  readPickedFontFamily,
} from '../../../src/shared/fonts/family'
import { validateSlideContract } from '../../../src/shared/document/slide-contract'
import { findForbiddenApiTokens, packForApiScan } from '../../../src/shared/document/forbidden-apis'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { applyOps } from '../../../src/shared/design/patch'
import {
  buildFieldOps,
  readPropertyValues,
  resolveElement,
} from '../../../src/shared/design/property-model'

/**
 * Names sampled from the OpenType `name` tables of a real Windows 11 install. They are here because
 * a plain `[A-Za-z0-9 ._-]` allow-list rejects every one of them, which would have hidden a fifth of
 * that machine's fonts — see the census in `src/shared/fonts/family.ts`.
 */
const REAL_NON_ASCII_NAMES = [
  'ＭＳ Ｐゴシック',
  'ＭＳ 明朝',
  'メイリオ',
  '游ゴシック Light',
  '宋体',
  '微软雅黑 Light',
  '맑은 고딕 Semilight',
  'HG丸ｺﾞｼｯｸM-PRO',
  '細明體_HKSCS-ExtB',
  'BIZ UDPMincho Medium',
]

/**
 * Family names whose first character is a decimal digit that is **not** ASCII `0`-`9`.
 *
 * `\p{Nd}` — the class the allow-list admits as a first character — covers Arabic-Indic, Devanagari,
 * fullwidth and the non-BMP mathematical digits, so every one of these is a name a font file on a
 * CJK or Arabic Windows install can legitimately carry, and every one reaches the CSS composer. They
 * are here because the leading-digit escape has to carry the character's *own* code point: a
 * hardcoded `\3` prefix wrote U+0003 into the declaration, and for the non-BMP digit it split a
 * surrogate pair in half.
 */
const DIGIT_LEAD_NAMES = [
  '1979 Sans', // ASCII — pinned so the fix stays byte-identical for the case that already worked
  '\u0663\u0662 Sans', // U+0663 ARABIC-INDIC DIGIT THREE
  '\u0967 Sans', // U+0967 DEVANAGARI DIGIT ONE
  '\uff11 Sans', // U+FF11 FULLWIDTH DIGIT ONE
  '\u{1D7CE} Sans', // U+1D7CE MATHEMATICAL BOLD DIGIT ZERO — a surrogate pair
]

/** Names that carry a CSS or HTML injection payload. Every one must be refused. */
const INJECTION_NAMES = [
  'Evil"; } body { background: red } .x {',
  'Arial; color: red',
  'Arial} body {display:none',
  'Foo</style><script>alert(1)</script>',
  'url(//evil.example/x.css)',
  'expression(alert(1))',
  'Back\\slash',
  'New\nline',
  'Carriage\rreturn',
  'Tab\tseparated',
  'Quote"inside',
  "Apostrophe'inside",
  '@import "x"',
  '-moz-binding',
  '/*comment*/',
  'Foo\u0000Bar',
  'Foo\u2028Bar',
  // Angle brackets as the *only* illegal characters. Every other payload here carries a second
  // reason to be refused, so widening the allow-list to admit `<` and `>` — one `\p{S}` away —
  // left the whole suite green.
  'Angle<Bracket>',
]

/**
 * Names carrying no forbidden token that the CSS escape layer *puts* one into.
 *
 * A leading digit has to be hex-escaped, and the escape ends in a space that SL-S04's packing then
 * strips: `८ventsource` (U+096E) composes to `\\96e ventsource, …` and packs to `\\96eventsource…`,
 * which contains `eventsource`. Enumerated rather than sampled — every `\p{Nd}` code point whose hex
 * spelling ends in `e` is one — so the test is over the property, not over three lucky examples.
 */
const ESCAPE_SYNTHESISED_NAMES = ((): string[] => {
  const names: string[] = []
  // Hex ending in `e` is exactly the low nibble being 14, so only one code point in sixteen is worth
  // testing at all — the whole of Unicode without the whole of Unicode's cost.
  for (let codePoint = 0xe; codePoint <= 0x10ffff; codePoint += 0x10) {
    const digit = String.fromCodePoint(codePoint)
    if (/\p{Nd}/u.test(digit)) names.push(`${digit}ventsource`)
  }
  return names
})()

/**
 * Families on the project's Windows host with an *inner* word that starts with a digit or a lone
 * `-`: 14 of its 515 allow-listed names, found by review round 7 by running the real enumerator.
 * `Wingdings 2`, `Wingdings 3` and `Bookshelf Symbol 7` ship with every Office install. A
 * `<family-name>` is `<custom-ident>+`, so each word has to be an identifier on its own — the
 * composer used to escape a leading digit of the *name* only, and Chromium dropped every one of
 * these declarations whole. No earlier fixture had such a word, which is how six rounds missed it.
 */
const DIGIT_LED_WORD_NAMES = [
  'Bauhaus 93',
  'Bookshelf Symbol 7',
  'FSP DEMO - Bank Gothic BT Light',
  'FSP DEMO - Bnk Gthc BT Mdm',
  'Modern No. 20',
  'Playfair 12pt',
  'Playfair 12pt Black',
  'Playfair 12pt ExtraBold',
  'Playfair 12pt Light',
  'Playfair 12pt Medium',
  'Playfair 12pt SemiBold',
  'Wingdings 2',
  'Wingdings 3',
  '000 Orange Fizz 2.0 TB',
]

/**
 * The bare `<generic-family>` keywords, written out rather than read from the module: the seven
 * `<generic-complete>` words Chromium drops a declaration for, and the four `<generic-incomplete>`
 * `ui-*` words Safari treats as generics. Nothing else in css-fonts-4 is a bare generic — `fangsong`,
 * `kai`, `khmer-mul` and `nastaliq` exist only inside `generic()`, and `emoji` not at all — and round
 * 9 was the cost of forgetting that: a word lifted from the spec's list into the set, and a stock
 * Windows face gone from the dropdown. So the set is pinned to exactly this.
 */
const GENERIC_FAMILY_KEYWORDS: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'math',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
])

/**
 * What Chromium enforces per word, stated as a regex because happy-dom cannot parse CSS: after
 * hex escapes are folded to a marker (their terminating space is not a word separator), every
 * word starts with a name-start code point, a `-` that is followed by one (or by `-`/an escape),
 * or an escape.
 */
function everyWordIsAnIdentifier(family: string): boolean {
  const folded = family.replace(/\\[0-9a-fA-F]{1,6} ?/g, '\\E')
  return folded
    .split(' ')
    .filter((word) => word !== '')
    .every((word) =>
      /^(?:[\p{L}_\u{0080}-\u{10FFFF}]|-(?:[\p{L}_\u{0080}-\u{10FFFF}-]|\\)|\\)/u.test(word),
    )
}

describe('font family name validation (M3.10)', () => {
  it('accepts the plain Latin names a stock machine actually has', () => {
    for (const name of ['Arial', 'Segoe UI', 'Gill Sans MT Ext Condensed Bold', 'Bodoni MT']) {
      expect(isValidFontFamilyName(name)).toBe(true)
    }
  })

  it('accepts the CJK, Hangul and fullwidth names an ASCII allow-list would silently drop', () => {
    for (const name of REAL_NON_ASCII_NAMES) {
      expect(isValidFontFamilyName(name)).toBe(true)
    }
  })

  it('rejects every injection payload', () => {
    for (const name of INJECTION_NAMES) {
      expect(isValidFontFamilyName(name), name).toBe(false)
    }
  })

  it('rejects non-strings and the empty string', () => {
    for (const value of [null, undefined, 42, {}, [], true, '', '   ']) {
      expect(isValidFontFamilyName(value)).toBe(false)
    }
  })

  it('rejects a name that does not begin with a letter or digit', () => {
    // The leading character is where `@` (at-rule) and `-` (custom property) would do damage.
    expect(isValidFontFamilyName(' Arial')).toBe(false)
    expect(isValidFontFamilyName('-Arial')).toBe(false)
    expect(isValidFontFamilyName('.Arial')).toBe(false)
    expect(isValidFontFamilyName('_Arial')).toBe(false)
    expect(isValidFontFamilyName('@Arial')).toBe(false)
  })

  it('enforces the length cap exactly at the boundary', () => {
    const ok = 'A'.repeat(MAX_FONT_FAMILY_NAME_LENGTH)
    const tooLong = 'A'.repeat(MAX_FONT_FAMILY_NAME_LENGTH + 1)
    expect(isValidFontFamilyName(ok)).toBe(true)
    expect(isValidFontFamilyName(tooLong)).toBe(false)
  })
})

/**
 * The non-obvious half of the threat model. These names pass the character allow-list, yet writing
 * them would make the slide fail its own Tier-1 contract, because SL-S04 matches its forbidden
 * tokens against the source with all whitespace stripped.
 */
/** A minimal contract-valid slide whose only heading carries the given `font-family` head. */
function withFace(family: string): string {
  return [
    '<!doctype html><html><head><style>',
    'html,body{margin:0;padding:0}*{box-sizing:border-box}',
    '.slide{width:1280px;height:720px;overflow:hidden;position:relative;padding:48px}',
    '</style></head><body><div class="slide" data-sl-id="e_root">',
    `<h1 data-sl-id="e_001" style="font-family: ${family}, sans-serif">Q3</h1>`,
    '</div></body></html>',
  ].join('')
}

describe('font names that would break the slide contract', () => {
  const CONTRACT_BREAKERS = [
    'Local Storage', // -> localstorage
    'Indexed DB', // -> indexeddb
    'Document.Cookie', // -> document.cookie
    'Web Socket', // -> websocket
    'Event Source', // -> eventsource
    'XML Http Request', // -> xmlhttprequest
    'Send Beacon', // -> sendbeacon
    'Display 3vh', // SL-G05's viewport-unit regex
    'Grid 10vw Condensed',
  ]

  it('are refused even though they contain only allow-listed characters', () => {
    for (const name of CONTRACT_BREAKERS) {
      // Character class alone would let these through — that is the point of the second guard.
      expect(/^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd} ._-]*$/u.test(name), name).toBe(true)
      expect(isContractSafeFontFamilyName(name), name).toBe(false)
      expect(isValidFontFamilyName(name), name).toBe(false)
    }
  })

  it('does not refuse ordinary names that merely resemble them', () => {
    for (const name of ['Local Gothic', 'Document Sans', 'Beacon Display', 'Socket Mono']) {
      expect(isValidFontFamilyName(name), name).toBe(true)
    }
  })

  it('would really break the slide — asked of the validator, not of a hand-packed string', () => {
    // What makes the guard load-bearing rather than decoration: writing one of these names produces
    // a slide the project's own Tier-1 validator rejects. If this stops holding, the guard can go.
    expect(validateSlideContract(withFace('Bodoni MT')).ok).toBe(true)

    const broken = validateSlideContract(withFace('Local Storage'))
    expect(broken.ok).toBe(false)
    expect(broken.issues.map((issue) => issue.rule)).toContain('SL-S04')

    const viewport = validateSlideContract(withFace('Display 3vh'))
    expect(viewport.ok).toBe(false)
    expect(viewport.issues.map((issue) => issue.rule)).toContain('SL-G05')
  })
})

/**
 * The half the character allow-list and the raw-name scan both miss: a name that is clean until the
 * composer touches it. The guard has to run on the bytes about to be written, or it is guarding a
 * string the slide never sees.
 */
describe('font names the CSS escape layer would turn into a forbidden token', () => {
  it('covers every code point that can do it — 18 of them', () => {
    expect(ESCAPE_SYNTHESISED_NAMES.length).toBe(18)
    expect(ESCAPE_SYNTHESISED_NAMES).toContain('\u096Eventsource')
    expect(ESCAPE_SYNTHESISED_NAMES).toContain('\u0A6Eventsource')
    expect(ESCAPE_SYNTHESISED_NAMES).toContain('\u0AEEventsource')
  })

  it('carries no forbidden token in the raw name, which is why scanning it is not enough', () => {
    for (const name of ESCAPE_SYNTHESISED_NAMES) {
      expect(findForbiddenApiTokens(name), name).toEqual([])
      // …and the character allow-list has no opinion either: a `\p{Nd}` lead is legitimate.
      expect(/^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd} ._-]*$/u.test(name), name).toBe(true)
    }
  })

  it('composes into one, which is the string the guard has to read', () => {
    // Asked of the real escaper: the hex escape it writes for the leading digit ends in `e`, and the
    // terminating space that follows it is exactly what the SL-S04 packing removes.
    for (const name of ESCAPE_SYNTHESISED_NAMES) {
      expect(
        packForApiScan(`${cssIdentFontFamily(name)}, Segoe UI, system-ui, sans-serif`),
        name,
      ).toContain('eventsource')
    }
  })

  it('is refused at every gate the name can reach', () => {
    for (const name of ESCAPE_SYNTHESISED_NAMES) {
      expect(isContractSafeFontFamilyName(name), name).toBe(false)
      expect(isValidFontFamilyName(name), name).toBe(false)
      expect(buildFontFamilyValue(name), name).toBeNull()
      expect(normalizeFontFamilies([name]), name).toEqual([])
    }
  })

  it('would really break the slide, asked of the validator', () => {
    // What makes this a blocker rather than a curiosity: the composed declaration in a real slide
    // is one SL-S04 rejects. Hand-composed here, because the composer now refuses to produce it.
    const slide = withFace('\\96e ventsource')
    const broken = validateSlideContract(slide)
    expect(broken.ok).toBe(false)
    expect(broken.issues.map((issue) => issue.rule)).toContain('SL-S04')
  })
})

describe('normalizeFontFamilies', () => {
  it('drops invalid entries without discarding the good ones', () => {
    const result = normalizeFontFamilies(['Arial', 'Evil"; }', 'Georgia', 42, null, 'url(x)'])
    expect(result).toEqual(['Arial', 'Georgia'])
  })

  it('trims, then folds case-insensitive duplicates to one entry', () => {
    expect(normalizeFontFamilies(['  Arial  ', 'ARIAL', 'arial', 'Georgia'])).toEqual([
      'Arial',
      'Georgia',
    ])
  })

  it('sorts, so the dropdown order does not depend on enumerator output order', () => {
    expect(normalizeFontFamilies(['Zapf', 'Arial', 'Mono'])).toEqual(['Arial', 'Mono', 'Zapf'])
  })

  it('caps the list length', () => {
    const many = Array.from({ length: MAX_SYSTEM_FONT_FAMILIES + 500 }, (_, i) => `Font${i}`)
    expect(normalizeFontFamilies(many)).toHaveLength(MAX_SYSTEM_FONT_FAMILIES)
  })

  it('keeps every real non-ASCII name', () => {
    expect(normalizeFontFamilies(REAL_NON_ASCII_NAMES)).toHaveLength(REAL_NON_ASCII_NAMES.length)
  })
})

/**
 * The escaper is tested with payloads the validator would already have refused, on purpose. It is a
 * second guard, and a guard that only holds because another guard ran is one guard.
 */
/**
 * True when `character` appears in `value` without an escaping backslash. Written as a scan rather
 * than a regex because the interesting case is a *run* of backslashes: `\\;` is an escaped
 * backslash followed by a bare semicolon, and must count as unescaped.
 */
function hasUnescaped(value: string, character: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== character) continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && value[j] === '\\'; j -= 1) backslashes += 1
    if (backslashes % 2 === 0) return true
  }
  return false
}

describe('cssIdentFontFamily', () => {
  it('leaves an ordinary name untouched — a space separates identifiers, it is not an escape site', () => {
    expect(cssIdentFontFamily('Segoe UI')).toBe('Segoe UI')
    expect(cssIdentFontFamily('Bodoni MT Poster Compressed')).toBe('Bodoni MT Poster Compressed')
  })

  it('leaves CJK, Hangul and fullwidth names unescaped: they are identifier code points', () => {
    for (const name of REAL_NON_ASCII_NAMES) {
      expect(cssIdentFontFamily(name), name).toBe(name)
    }
  })

  it('backslash-escapes a dot, which is not an identifier character', () => {
    expect(cssIdentFontFamily('Foo.Bar')).toBe('Foo\\.Bar')
  })

  it('escapes a leading digit, which cannot start an identifier', () => {
    expect(cssIdentFontFamily('1979 Sans')).toBe('\\31 979 Sans')
  })

  it('escapes a digit that starts any WORD, because each word is an identifier of its own', () => {
    expect(cssIdentFontFamily('Wingdings 2')).toBe('Wingdings \\32 ')
    expect(cssIdentFontFamily('Bookshelf Symbol 7')).toBe('Bookshelf Symbol \\37 ')
    expect(cssIdentFontFamily('Playfair 12pt')).toBe('Playfair \\31 2pt')
    expect(cssIdentFontFamily('Modern No. 20')).toBe('Modern No\\. \\32 0')
    expect(cssIdentFontFamily('Foo 1.5')).toBe('Foo \\31 \\.5')
    // The spec's own example: `5-0` is a <number> followed by `-0`, not an identifier.
    expect(cssIdentFontFamily('Hawaii 5-0')).toBe('Hawaii \\35 -0')
  })

  it('escapes a word that is a lone `-` or a `-` before a digit, and leaves `-Bold` alone', () => {
    expect(cssIdentFontFamily('FSP DEMO - Bank Gothic BT Light')).toBe(
      'FSP DEMO \\- Bank Gothic BT Light',
    )
    expect(cssIdentFontFamily('Sans -')).toBe('Sans \\-')
    expect(cssIdentFontFamily('Sans -1')).toBe('Sans \\-1')
    // `-` + name-start, `--`, and `-` + non-ASCII are identifier starts already.
    expect(cssIdentFontFamily('Sans -Bold')).toBe('Sans -Bold')
    expect(cssIdentFontFamily('Sans --x')).toBe('Sans --x')
    expect(cssIdentFontFamily('Sans -\u0663')).toBe('Sans -\u0663')
  })

  it('composes every word of the Windows host corpus into an identifier', () => {
    for (const name of [
      ...DIGIT_LED_WORD_NAMES,
      'Hawaii 5-0',
      '1979 Sans',
      'Segoe UI',
      'Foo.Bar',
    ]) {
      expect(isValidFontFamilyName(name), name).toBe(true)
      const value = buildFontFamilyValue(name)
      expect(value, name).not.toBeNull()
      expect(everyWordIsAnIdentifier(value!.split(',')[0]!), value!).toBe(true)
    }
    // …and the predicate can say no: this is the exact string the composer used to write.
    expect(everyWordIsAnIdentifier('Wingdings 2')).toBe(false)
    expect(everyWordIsAnIdentifier('FSP DEMO - Bank')).toBe(false)
  })

  it('lets nothing through normalisation whose composed value begins with a generic', () => {
    // Asked of the survivors of `normalizeFontFamilies` over the corpus WITH a leading-generic name
    // planted in it, so the assertion has something to catch: were the first-word check missing,
    // `Serif Gothic` would survive and its composed value would begin with `serif` (round 9 found
    // the earlier form of this assertion vacuous — its corpus had no such name to refuse).
    const survivors = normalizeFontFamilies([
      ...DIGIT_LED_WORD_NAMES,
      'Serif Gothic',
      'Cursive Standard Italic',
      'Gothic Serif',
      'Fantasque Sans Mono',
      'FangSong',
    ])
    expect(survivors).not.toContain('Serif Gothic')
    expect(survivors).not.toContain('Cursive Standard Italic')
    expect(survivors).toContain('Gothic Serif')
    expect(survivors).toContain('FangSong')
    expect(survivors).toHaveLength(DIGIT_LED_WORD_NAMES.length + 3)
    for (const name of survivors) {
      const family = buildFontFamilyValue(name)!.split(',')[0]!
      expect(everyWordIsAnIdentifier(family), name).toBe(true)
      expect(GENERIC_FAMILY_KEYWORDS.has(family.split(' ')[0]!.toLowerCase()), name).toBe(false)
    }
  })

  it('escapes a leading NON-ASCII digit with its own code point, not a hardcoded \\3', () => {
    // `\\3` is the escape for U+0033, i.e. the character `3` — correct only for ASCII `0`-`9`.
    // `\\3` + `\u0663` decodes as U+0003 followed by a stray `\u0663`: a font that cannot exist.
    expect(cssIdentFontFamily('\u0663\u0662 Sans')).toBe('\\663 \u0662 Sans')
    expect(cssIdentFontFamily('\u0967 Sans')).toBe('\\967  Sans')
    expect(cssIdentFontFamily('\uff11 Sans')).toBe('\\ff11  Sans')
  })

  it('slices a leading digit by code point, so a non-BMP digit cannot leave a lone surrogate', () => {
    // `out[0]` on `\u{1D7CE}` takes half a surrogate pair; the escape then carries the other half
    // into slide source, which no longer survives a UTF-8 save.
    expect(cssIdentFontFamily('\u{1D7CE} Sans')).toBe('\\1d7ce  Sans')
  })

  it('hex-escapes a newline, which cannot follow a bare backslash', () => {
    expect(cssIdentFontFamily('a\nb')).toBe('a\\a b')
  })

  it('hex-escapes NUL and the Unicode line separator', () => {
    expect(cssIdentFontFamily('a\u0000b')).toBe('a\\0 b')
    expect(cssIdentFontFamily('a\u2028b')).toBe('a\\2028 b')
  })

  it('hex-escapes a lone surrogate, which the identifier range would otherwise admit', () => {
    // Unreachable through `buildFontFamilyValue`, which validates first — but this composer
    // advertises itself as safe on its own, and CSS calls every code point from U+0080 up an
    // identifier code point, unpaired surrogates included.
    expect(cssIdentFontFamily('A\uD800B')).toBe('A\\d800 B')
    expect(cssIdentFontFamily('A\uDFFFB')).toBe('A\\dfff B')
  })

  it('neutralises every injection payload: no bare delimiter survives', () => {
    // Nothing that could end a declaration, a rule, an attribute or a <style> element may remain
    // unescaped in the identifier this composer emits.
    // Backslash is deliberately absent: it *is* the escape mechanism, so asking for it to be
    // escaped would be asking the escaper to defeat itself.
    const DELIMITERS = [';', '{', '}', '"', "'", '<', '>', '(', ')', '@', '/', ':', ',']
    for (const name of INJECTION_NAMES) {
      const ident = cssIdentFontFamily(name)
      for (const character of DELIMITERS) {
        expect(hasUnescaped(ident, character), name + ' -> ' + ident + ' / ' + character).toBe(
          false,
        )
      }
      // A trailing lone backslash would escape the comma that follows it in the stack, swallowing
      // the fallback chain.
      expect(/(^|[^\\])(\\\\)*\\$/.test(ident), name).toBe(false)
    }
  })

  it('round-trips through the reader for every payload it is handed', () => {
    for (const name of [
      ...REAL_NON_ASCII_NAMES,
      ...DIGIT_LEAD_NAMES,
      'Foo.Bar',
      'Segoe UI',
      'Evil"; } body {',
    ]) {
      expect(readPickedFontFamily(cssIdentFontFamily(name)), name).toBe(name)
    }
  })
})

describe('buildFontFamilyValue', () => {
  it('writes the milestone stack for an installed, non-system face', () => {
    expect(buildFontFamilyValue('Papyrus')).toBe('Papyrus, Segoe UI, system-ui, sans-serif')
  })

  it('writes a multi-word or non-ASCII name as a bare identifier sequence', () => {
    expect(buildFontFamilyValue('Bodoni MT')).toBe('Bodoni MT, Segoe UI, system-ui, sans-serif')
    expect(buildFontFamilyValue('ＭＳ Ｐゴシック')).toBe(
      'ＭＳ Ｐゴシック, Segoe UI, system-ui, sans-serif',
    )
  })

  it('never emits a quote, because an inline style attribute cannot carry one', () => {
    // `escapeAttrValue` would write `"` as `&quot;`, and that trailing `;` splits the declaration
    // parser — see the note on `cssIdentFontFamily`. This is the assertion that pins it.
    for (const name of ['Papyrus', 'Bodoni MT', 'ＭＳ Ｐゴシック', 'Georgia', 'Foo.Bar']) {
      expect(buildFontFamilyValue(name), name).not.toContain('"')
      expect(buildFontFamilyValue(name), name).not.toContain("'")
    }
  })

  it('does not put a sans-serif ahead of the generic for a serif or monospace pick', () => {
    // Segoe UI would always resolve, so leaving it in would mean a missing Georgia rendered sans.
    expect(buildFontFamilyValue('Georgia')).toBe('Georgia, serif')
    expect(buildFontFamilyValue('Courier New')).toBe('Courier New, monospace')
  })

  it('refuses a face whose name is a CSS keyword instead of escaping it', () => {
    // Escaping the first character was the old answer and it is inert: CSS resolves escapes into the
    // ident's value, so `\\53 erif` IS `serif` — Chromium computes it to the generic and drops
    // `\\49 nherit` entirely. Quoting is the only emission that would work, and a quoted family in an
    // inline style is a source-corrupting write here. So these names are simply not written.
    for (const name of [
      'Serif',
      'sans-serif',
      'MONOSPACE',
      'cursive',
      'fantasy',
      'math',
      'ui-serif',
      'ui-sans-serif',
      'ui-monospace',
      'ui-rounded',
      'Inherit',
      'initial',
      'unset',
      'revert',
      'revert-layer',
      'Default',
    ]) {
      expect(isValidFontFamilyName(name), name).toBe(false)
      expect(buildFontFamilyValue(name), name).toBeNull()
    }
    // Never emitted, so never shown: a row the user can click that does nothing is worse than one
    // name fewer in a list of hundreds.
    expect(normalizeFontFamilies(['Arial', 'Serif', 'Default', 'Georgia'])).toEqual([
      'Arial',
      'Georgia',
    ])
  })

  it('refuses a name whose FIRST word is a generic family, which makes the whole value that generic', () => {
    // `Serif Gothic, Segoe UI, …` is the generic `serif` followed by a stray ident: Chromium drops
    // the declaration whole, the row previews in the inherited face and the trigger reads the source
    // back as applied. Until round 8 this file asserted the opposite for `Serif Pro`.
    for (const name of [
      'Serif Pro',
      'Serif Gothic',
      'serif 2',
      'SANS-SERIF Gothic',
      'Monospace Two',
      'Cursive Standard',
      'Fantasy Land',
      'Math Sans',
      'system-ui Gothic',
      'ui-serif Pro',
      'ui-rounded Display',
      // Three and four words too: a check keyed on the LAST space, or on two-word names only, is
      // indistinguishable from the right one on the pairs above (round 10). All measured DROP.
      'Serif Gothic Bold',
      'Cursive Standard Italic',
      'Math Sans Bold',
      'Sans-Serif Gothic Bold Italic',
    ]) {
      expect(isValidFontFamilyName(name), name).toBe(false)
      expect(buildFontFamilyValue(name), name).toBeNull()
    }
    expect(normalizeFontFamilies(['Serif Gothic', 'Gothic Serif'])).toEqual(['Gothic Serif'])
  })

  it('is exactly the bare generics of css-fonts-4 — no more, so a font is never refused for a word that is not one', () => {
    expect([...GENERIC_FAMILY_WORDS].toSorted()).toEqual([...GENERIC_FAMILY_KEYWORDS].toSorted())
  })

  it('keeps every word that is a generic only inside generic(), or in no spec at all', () => {
    // Alone and as a first word. `KaiTi` and `Noto Nastaliq Urdu` are the stock faces nearby; the
    // bare words themselves are what the set must not grow to include.
    for (const word of ['fangsong', 'kai', 'khmer-mul', 'nastaliq', 'emoji']) {
      for (const name of [word, `${word} Display`]) {
        expect(isValidFontFamilyName(name), name).toBe(true)
        expect(buildFontFamilyValue(name), name).toBe(`${name}, Segoe UI, system-ui, sans-serif`)
      }
    }
  })

  it('keeps a name that merely contains a keyword later, and the system-ui keyword itself', () => {
    // Real families from the Windows host, plus the CSS-wide keyword case, which only matters when
    // it is the whole value: Chromium accepts `default Gothic` and parses it as a family.
    for (const name of [
      'Gothic Serif',
      'Noto Serif JP',
      'Microsoft Sans Serif',
      'MS Reference Sans Serif',
      'Sans Serif Collection',
      'Cambria Math',
      'Segoe UI Emoji',
      'Default Gothic',
      // Not generics in any engine, nor bare ones in the current spec (`generic(fangsong)` is its
      // only form). `FangSong` is `simfang.ttf`, on every Windows since 7; round 9 found it refused.
      'FangSong',
      'Fangsong Song',
      'Emoji One',
      // A word that merely *starts* with a generic is a family. Two checks are exercised here and
      // they see different names: the single words (`Serifa`, `Monospaced`) reach only the
      // whole-name check, and the spaced ones (`Mathilde Script`, `Serifa Std`, `Monospaced Two`,
      // `Cursiver Display`) only the first-word check — a prefix match in either reds here.
      // `Fantasque Sans Mono` is the real-world face that motivates the exact match, though
      // `fantasque` does not itself start with `fantasy`.
      'Fantasque Sans Mono',
      'Serifa',
      'Monospaced',
      'Mathilde Script',
      'Serifa Std',
      'Monospaced Two',
      'Cursiver Display',
    ]) {
      expect(isValidFontFamilyName(name), name).toBe(true)
      expect(buildFontFamilyValue(name), name).toBe(`${name}, Segoe UI, system-ui, sans-serif`)
    }
    expect(isValidFontFamilyName('system-ui')).toBe(true)
  })

  it('refuses a name with two consecutive spaces, which no identifier sequence can address', () => {
    // `Foo  Bar` as idents resolves to the family `Foo Bar` (Chromium serialises it back that way),
    // so writing it would make the panel show one name while the renderer looked up another.
    expect(isValidFontFamilyName('Foo  Bar')).toBe(false)
    expect(isValidFontFamilyName('A  2')).toBe(false)
    expect(buildFontFamilyValue('Foo  Bar')).toBeNull()
    expect(normalizeFontFamilies(['Foo  Bar', 'Foo Bar'])).toEqual(['Foo Bar'])
    // Trimming still happens before the check, so padded enumerator output is not refused for it.
    expect(normalizeFontFamilies(['  Foo Bar  '])).toEqual(['Foo Bar'])
  })

  it('leaves the system-ui keyword unquoted', () => {
    expect(buildFontFamilyValue('system-ui')).toBe('system-ui, sans-serif')
  })

  it('returns null for every injection payload rather than writing something', () => {
    for (const name of INJECTION_NAMES) {
      expect(buildFontFamilyValue(name), name).toBeNull()
    }
  })

  it('returns null for a contract-breaking name', () => {
    expect(buildFontFamilyValue('Local Storage')).toBeNull()
  })

  it('never emits a character that would end a style attribute or a declaration', () => {
    for (const name of [...REAL_NON_ASCII_NAMES, 'Papyrus', 'Georgia']) {
      const value = buildFontFamilyValue(name)
      expect(value).not.toBeNull()
      expect(/[;{}]/.test(value!), name).toBe(false)
    }
  })
})

describe('readPickedFontFamily', () => {
  it('reads back exactly what buildFontFamilyValue wrote', () => {
    for (const name of [
      'Papyrus',
      'Georgia',
      'ＭＳ Ｐゴシック',
      'system-ui',
      'Hawaii 5-0',
      'Foo 1.5',
      ...DIGIT_LED_WORD_NAMES,
    ]) {
      expect(readPickedFontFamily(buildFontFamilyValue(name)), name).toBe(name)
    }
  })

  it('returns the first family of a stack this module did not write', () => {
    expect(readPickedFontFamily("'Comic Sans MS', cursive")).toBe('Comic Sans MS')
    expect(readPickedFontFamily('inherit')).toBe('inherit')
  })

  it('is null for an absent declaration', () => {
    expect(readPickedFontFamily(null)).toBeNull()
    expect(readPickedFontFamily('')).toBeNull()
  })

  /**
   * Slide HTML is model-authored and the Tier-1 contract has nothing to say about a `font-family`
   * escape, so this reader runs on untrusted source — inside the property panel's render, where a
   * throw unmounts the tree. Every one of these threw a `RangeError` before the clamp.
   */
  it('never throws on a declaration no one validated', () => {
    for (const value of [
      'A\\ffffff B, serif',
      'A\\110000 B, serif',
      'A\\7fffffff B, serif',
      'A\\d800 B, serif',
      'A\\dfff B, serif',
      'A\\0 B, serif',
      '\\ffffff',
      'A\\',
      '\\',
      'A\\\nB',
      '"A\\ffffff B"',
    ]) {
      expect(() => readPickedFontFamily(value), JSON.stringify(value)).not.toThrow()
    }
  })

  it('substitutes U+FFFD for an escape the CSS tokenizer would not accept', () => {
    // CSS Syntax §4.3.7: out of range, a surrogate half or zero is U+FFFD, and so is a backslash
    // that starts no escape at all.
    expect(readPickedFontFamily('A\\ffffff B, serif')).toBe('A\uFFFDB')
    expect(readPickedFontFamily('A\\110000 B, serif')).toBe('A\uFFFDB')
    expect(readPickedFontFamily('A\\d800 B, serif')).toBe('A\uFFFDB')
    expect(readPickedFontFamily('A\\0 B, serif')).toBe('A\uFFFDB')
    expect(readPickedFontFamily('\\')).toBe('\uFFFD')
    // In range and legal, so it still decodes: U+10FFFF is the boundary from the other side.
    expect(readPickedFontFamily('A\\10ffff B, serif')).toBe('A\u{10FFFF}B')
  })

  it('leaks neither a NUL nor a lone surrogate into the panel state', () => {
    for (const value of ['A\\0 B', 'A\\d800 B', 'A\\dfff B', 'A\\dc00 B']) {
      const read = readPickedFontFamily(value)!
      expect(read.includes('\u0000'), value).toBe(false)
      expect(/\p{Cs}/u.test(read), value).toBe(false)
    }
  })
})

describe('SYSTEM_FONT_GROUP', () => {
  it('contains only names the validator accepts', () => {
    for (const entry of SYSTEM_FONT_GROUP) {
      expect(isValidFontFamilyName(entry.name), entry.name).toBe(true)
      expect(isSystemGroupFamily(entry.name)).toBe(true)
    }
  })

  it('does not claim an arbitrary installed face is in the group', () => {
    expect(isSystemGroupFamily('Papyrus')).toBe(false)
  })
})

/**
 * The end-to-end property the milestone actually requires: after a pick, the slide still passes
 * Tier-1. Run over the hostile names too — those must simply not change the source at all.
 */
describe('a picked font leaves the slide contract-valid', () => {
  const SLIDE = [
    '<!doctype html><html><head><style>',
    'html,body{margin:0;padding:0}*{box-sizing:border-box}',
    '.slide{width:1280px;height:720px;overflow:hidden;position:relative;padding:48px}',
    '</style></head><body>',
    '<div class="slide" data-sl-id="e_root"><h1 data-sl-id="e_001" style="font-size: 44px">Q3</h1></div>',
    '</body></html>',
  ].join('')

  function pick(name: string): string {
    const map = buildSlideMap('s1', SLIDE)
    const heading = map.order.find((id) => map.byId.get(id)?.tagName === 'h1')!
    const element = resolveElement(map, heading)!
    const ops = buildFieldOps(map.source, element, 'fontFamily', name)
    return ops.length === 0 ? map.source : applyOps(map.source, ops)
  }

  it('starts from a contract-valid slide', () => {
    expect(validateSlideContract(SLIDE).ok).toBe(true)
  })

  it('stays valid for ordinary and non-ASCII picks', () => {
    for (const name of ['Papyrus', 'Georgia', 'ＭＳ Ｐゴシック', '맑은 고딕']) {
      const patched = pick(name)
      expect(patched, name).not.toBe(SLIDE)
      expect(validateSlideContract(patched).ok, name).toBe(true)
    }
  })

  it('leaves the source byte-identical for a hostile or contract-breaking name', () => {
    for (const name of [...INJECTION_NAMES, 'Local Storage', 'Display 3vh', 'Serif']) {
      expect(pick(name), name).toBe(SLIDE)
    }
  })

  it('stays valid for a name whose escape would have synthesised a forbidden token', () => {
    for (const name of ESCAPE_SYNTHESISED_NAMES) {
      expect(pick(name), name).toBe(SLIDE)
      expect(validateSlideContract(pick(name)).ok, name).toBe(true)
    }
  })

  it('writes a byte-minimal splice: only the style attribute changes', () => {
    const patched = pick('Papyrus')
    expect(patched).toContain('font-size: 44px')
    expect(patched).toContain('font-family: Papyrus, Segoe UI, system-ui, sans-serif')
    // Everything outside the edited element is untouched.
    expect(patched.slice(0, patched.indexOf('<h1'))).toBe(SLIDE.slice(0, SLIDE.indexOf('<h1')))
    expect(patched.slice(patched.indexOf('</h1>'))).toBe(SLIDE.slice(SLIDE.indexOf('</h1>')))
  })

  it('keeps the map id set identical, so the selection survives the pick', () => {
    const before = buildSlideMap('s1', SLIDE)
    const after = buildSlideMap('s1', pick('Papyrus'))
    expect(after.order).toEqual(before.order)
  })

  it('round-trips a non-ASCII digit lead through save, reopen and a second edit', () => {
    for (const name of DIGIT_LEAD_NAMES) {
      const patched = pick(name)
      expect(patched, name).not.toBe(SLIDE)
      expect(validateSlideContract(patched).ok, name).toBe(true)

      // Save: a lone surrogate half does not survive a UTF-8 encode, it comes back as U+FFFD. And
      // a `\\3` prefix on a non-ASCII digit decodes to a literal U+0003 in the declaration.
      expect(Buffer.from(patched, 'utf8').toString('utf8'), name).toBe(patched)
      expect(patched.includes('\u0003'), name).toBe(false)

      // Reopen: the panel reads back the face the user actually picked, not a mangled one.
      const reopened = buildSlideMap('s1', patched)
      const heading = reopened.order.find((id) => reopened.byId.get(id)?.tagName === 'h1')!
      const element = resolveElement(reopened, heading)!
      expect(
        readPickedFontFamily(readPropertyValues(reopened.source, element).fontFamily),
        name,
      ).toBe(name)

      // Re-edit another property: the family declaration is re-serialised byte-identically.
      const edited = applyOps(
        reopened.source,
        buildFieldOps(reopened.source, element, 'fontSize', '60'),
      )
      expect(edited, name).toContain(`font-family: ${buildFontFamilyValue(name)!}`)
      expect(edited, name).toContain('font-size: 60px')
    }
  })
})
