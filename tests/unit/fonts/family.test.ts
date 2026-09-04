import { describe, expect, it } from 'vitest'

import {
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
]

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

  it('escapes a face whose name is a CSS keyword, so it stays a family', () => {
    // Bare `Serif` would resolve to the generic, not to the installed face called Serif.
    expect(buildFontFamilyValue('Serif')).toBe('\\53 erif, Segoe UI, system-ui, sans-serif')
    expect(buildFontFamilyValue('Inherit')).toBe('\\49 nherit, Segoe UI, system-ui, sans-serif')
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
    for (const name of ['Papyrus', 'Georgia', 'ＭＳ Ｐゴシック', 'system-ui']) {
      expect(readPickedFontFamily(buildFontFamilyValue(name))).toBe(name)
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
    for (const name of [...INJECTION_NAMES, 'Local Storage', 'Display 3vh']) {
      expect(pick(name), name).toBe(SLIDE)
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
