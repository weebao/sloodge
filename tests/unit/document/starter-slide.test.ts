import { describe, expect, it } from 'vitest'
import { newSlideId } from '../../../src/shared/document/deck'
import {
  assertSafeThemeToken,
  createStarterSlideHtml,
  DEFAULT_THEME_TOKENS,
  MAX_THEME_TOKEN_VALUE_LENGTH,
  renderThemeBlock,
  SLIDE_CONTRACT_VERSION,
  ThemeTokenError,
} from '../../../src/shared/document/starter-slide'
import { escapeHtml } from '../../../src/shared/document/slide-text'
import {
  FORBIDDEN_API_TOKENS,
  packForApiScan,
  validateSlideContract,
} from '../../../src/shared/document/slide-contract'

const ID = newSlideId(1_770_000_000_000)

describe('starter slide template', () => {
  it('emits the §3.1 skeleton with the contract attributes', () => {
    const html = createStarterSlideHtml({ id: ID, title: 'Hello' })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain(`data-sl-slide="${ID}"`)
    expect(html).toContain(`data-sl-contract="${String(SLIDE_CONTRACT_VERSION)}"`)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<div class="slide" data-sl-id="e_root">')
    expect(html).toContain('data-sl-id="e_001"')
  })

  it('locks the 1280x720 geometry and the mandatory resets', () => {
    const html = createStarterSlideHtml({ id: ID })
    expect(html).toContain('width: 1280px')
    expect(html).toContain('height: 720px')
    expect(html).toContain('overflow: hidden')
    expect(html).toContain('position: relative')
    expect(html).toContain('html, body { margin: 0; padding: 0;')
    expect(html).toContain('box-sizing: border-box')
    expect(html).toContain('padding: var(--sl-pad)')
  })

  it('is self-contained: no external subresources, no forbidden APIs, no vh/vw', () => {
    const html = createStarterSlideHtml({ id: ID, subtitle: 'sub' })
    expect(html).not.toMatch(/<link\b/)
    expect(html).not.toMatch(/<script\b/)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/@import|@font-face/)
    expect(html).not.toMatch(/\b\d+(vh|vw|dvh)\b/)
    expect(html).not.toMatch(/position:\s*fixed/)
  })

  it('carries a versioned sl:theme sentinel block for mechanical retheming', () => {
    const html = createStarterSlideHtml({ id: ID, themeVersion: 7 })
    expect(html).toContain('/* sl:theme:start v=7 */')
    expect(html).toContain('/* sl:theme:end */')
    expect(html.indexOf('sl:theme:start')).toBeLessThan(html.indexOf('sl:theme:end'))
    expect(html).toContain('--sl-bg: #0d1220;')
  })

  it('keeps every declared font-size at or above 16px', () => {
    const html = createStarterSlideHtml({ id: ID, subtitle: 'sub' })
    const sizes = [...html.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]))
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16)
  })

  it('escapes user text into both the <title> and the heading', () => {
    const html = createStarterSlideHtml({ id: ID, title: '<script>alert("x")</script>' })
    expect(html).not.toContain('<script>')
    // `alert(` is also an SL-S04 token, so its first letter is a numeric reference; resolve those
    // to see the escaping on its own.
    expect(
      html.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code))),
    ).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(escapeHtml(`a&b<c>'d"`)).toBe('a&amp;b&lt;c&gt;&#39;d&quot;')
  })

  it('omits the subtitle element entirely when no subtitle is given', () => {
    expect(createStarterSlideHtml({ id: ID })).not.toContain('data-sl-id="e_002"')
    expect(createStarterSlideHtml({ id: ID, subtitle: 'yes' })).toContain('data-sl-id="e_002"')
  })

  /**
   * M4.5 review round 3: a `.potx` whose `dc:title` read "Using localStorage wisely" produced a
   * starter slide that failed SL-S04, because the title was escaped but not defused. The title and
   * subtitle are caller text (an archive's, a user's, an agent's), so the starter slide must stay
   * contract-clean for every spelling the validator would flag — iterated from the rule's own list.
   */
  it('stays contract-valid for a title or subtitle that mentions a forbidden API', () => {
    expect(FORBIDDEN_API_TOKENS.length).toBeGreaterThan(10)
    for (const token of FORBIDDEN_API_TOKENS) {
      const packed = packForApiScan(token)
      for (const spelling of [token, packed, token.toUpperCase(), packed.split('').join(' ')]) {
        expect(packForApiScan(spelling)).toContain(packed)
        const html = createStarterSlideHtml({
          id: ID,
          title: `About ${spelling} today`,
          subtitle: spelling,
        })
        const errors = validateSlideContract(html, ['static']).issues.filter(
          (issue) => issue.severity === 'error',
        )
        expect(errors, JSON.stringify(spelling)).toEqual([])
      }
    }
  })

  it('renders the defused title unchanged once entities resolve', () => {
    const html = createStarterSlideHtml({ id: ID, title: 'How to fetch(data)' })
    expect(html).not.toContain('fetch(')
    expect(
      html.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code))),
    ).toContain('<h1 data-sl-id="e_001" class="title">How to fetch(data)</h1>')
  })
})

describe('theme token validation (M2)', () => {
  it('accepts the shipped defaults unchanged', () => {
    for (const [name, value] of Object.entries(DEFAULT_THEME_TOKENS)) {
      expect(() => assertSafeThemeToken(name, value)).not.toThrow()
    }
    expect(renderThemeBlock()).toContain('--sl-font: -apple-system')
  })

  it('a hostile token value cannot close the style element or inject markup', () => {
    // The r2 proof-of-concept, verbatim: theme.json token values are bare strings in the schema.
    const hostile = 'x; } </style><script>alert(1)</script><style> :root {'
    expect(() => renderThemeBlock({ '--sl-bg': hostile })).toThrow(ThemeTokenError)
    expect(() =>
      createStarterSlideHtml({ id: ID, tokens: { ...DEFAULT_THEME_TOKENS, '--sl-bg': hostile } }),
    ).toThrow(ThemeTokenError)
  })

  it.each([
    ['</style>', 'red</style>'],
    ['a closing brace', 'red }'],
    ['an extra declaration', 'red; background: url(x)'],
    ['a comment opener', 'red /* sl:theme:end */'],
    ['a comment closer', 'red */'],
    ['an at-rule', '@import url(x)'],
    ['a CSS escape', 'red \\3c script'],
    ['a newline', 'red\n  }'],
    ['a NUL', 'red \u0000'],
  ])('rejects a value carrying %s', (_label, value) => {
    expect(() => assertSafeThemeToken('--sl-bg', value)).toThrow(ThemeTokenError)
  })

  it('a token value cannot make the slide fetch a subresource (SL-S01)', () => {
    // The r3 proof-of-concept: no `<`, no `;`, no `@`, no comment — the r3 denylist passed it, and
    // `--sl-bg` is consumed by `background: var(--sl-bg)`, so rendering the deck beaconed out.
    const beacon = 'url(//evil.example/beacon.png)'
    expect(() => assertSafeThemeToken('--sl-bg', beacon)).toThrow(ThemeTokenError)
    expect(() => renderThemeBlock({ '--sl-bg': beacon })).toThrow(ThemeTokenError)
    expect(() =>
      createStarterSlideHtml({ id: ID, tokens: { ...DEFAULT_THEME_TOKENS, '--sl-bg': beacon } }),
    ).toThrow(ThemeTokenError)
  })

  it.each([
    ['image-set', 'image-set(url(//evil.example/x.png) 1x)'],
    ['a var() fallback', 'var(--nope, url(//evil.example/x.png))'],
    ['src()', 'src(//evil.example/x.png)'],
    ['element()', 'element(#leak)'],
    ['a gradient', 'linear-gradient(#000, #fff)'],
    ['a bare paren', 'calc(1px)'],
    ['an unmatched close paren', 'red)'],
  ])('rejects the functional notation %s', (_label, value) => {
    // Not an enumeration of fetching functions — `(` and `)` are banned outright, so v1 tokens are
    // parenthesis-free and a function nobody has invented yet is rejected on the same rule.
    expect(() => assertSafeThemeToken('--sl-bg', value)).toThrow(ThemeTokenError)
  })

  it.each(['sl-bg', '--sl bg', '--SL-BG', '--sl-bg: red; --other', '', '--'])(
    'rejects the token name %s',
    (name) => {
      expect(() => assertSafeThemeToken(name, 'red')).toThrow(ThemeTokenError)
    },
  )

  it('caps the value length', () => {
    expect(() =>
      assertSafeThemeToken('--sl-font', 'a'.repeat(MAX_THEME_TOKEN_VALUE_LENGTH)),
    ).not.toThrow()
    expect(() =>
      assertSafeThemeToken('--sl-font', 'a'.repeat(MAX_THEME_TOKEN_VALUE_LENGTH + 1)),
    ).toThrow(/limit/)
  })

  it('still emits ordinary values, quotes and commas included', () => {
    const block = renderThemeBlock({ '--sl-font': "Inter, 'Segoe UI', sans-serif" }, 3)
    expect(block).toContain("--sl-font: Inter, 'Segoe UI', sans-serif;")
    expect(block).toContain('/* sl:theme:start v=3 */')
  })
})

describe('attribute escaping', () => {
  it('escapes the slide id in data-sl-slide so a hostile id cannot inject attributes', () => {
    // SlideId is a bare string at the type level, so escaping is the only real guard.
    const html = createStarterSlideHtml({
      id: 's_01H8" onload="alert(1)' as never,
      title: 'x',
    })
    expect(html).not.toContain('onload="alert(1)"')
    expect(html).toContain('data-sl-slide="s_01H8&quot; onload=&quot;alert(1)"')
  })
})
