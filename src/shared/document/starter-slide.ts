/**
 * The canonical "New Slide" HTML — the skeleton of §3.1 of 30-slide-format.md, emitted as a
 * complete, standalone, self-contained 1280x720 document.
 *
 * Deliberately contract-clean so a fresh slide always lints green on Tier 1:
 *   SL-G01/G02  exactly one `.slide` root at 1280x720, overflow:hidden, position:relative
 *   SL-G03      html,body reset + universal box-sizing
 *   SL-G04      48px root inset
 *   SL-S01..04  zero subresources, zero network/storage APIs, system font stack only — the title
 *               and subtitle go through `slideText`, so a caller-supplied "fetch( basics" cannot
 *               put a forbidden token into the source (M4.5 review r3)
 *   SL-D01      every element inside `.slide` carries a unique data-sl-id, root is e_root
 *   SL-C01      nothing below 16px
 *   SL-T02      the theme token block is wrapped in `sl:theme` sentinels so a theme change is
 *               a byte-range replacement, not a re-render (§4.1)
 */

import { escapeHtml, slideText } from './slide-text'
import { CANVAS_HEIGHT, CANVAS_WIDTH, type SlideId } from './types'

/** Contract version stamped on `<html data-sl-contract>` (§5.1). */
export const SLIDE_CONTRACT_VERSION = 1

export const SYSTEM_FONT_STACK = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

export const DEFAULT_THEME_TOKENS = {
  '--sl-bg': '#0d1220',
  '--sl-fg': '#f0f0f5',
  '--sl-accent': '#4c8dff',
  '--sl-muted': '#9aa4b8',
  '--sl-font': SYSTEM_FONT_STACK,
  '--sl-radius': '14px',
  '--sl-pad': '48px',
} as const

export type StarterSlideOptions = {
  id: SlideId
  title?: string
  /** Optional caption under the title; omitted entirely when absent. */
  subtitle?: string
  /** Token map inlined between the `sl:theme` sentinels. */
  tokens?: Readonly<Record<string, string>>
  /** Theme version recorded in the sentinel (`v=`), matched against `theme.json.version`. */
  themeVersion?: number
}

/**
 * A CSS custom-property name we are willing to emit. Deliberately narrower than the CSS grammar
 * (which allows escapes and almost any code point): the only names this app generates are
 * `--sl-*`, and an allowlist cannot be out-thought the way an escaper can.
 */
export const THEME_TOKEN_NAME_PATTERN = /^--[a-z0-9-]+$/

/**
 * A token *value* is emitted inside a `<style>` element, which is a raw-text context: HTML entity
 * escaping does nothing there, so a value that ends the element mid-declaration injects markup.
 * Rejected outright: `<` and `>` (leave the style element), braces (leave the rule block), the
 * semicolon (append a further declaration), both CSS comment delimiters (the `sl:theme` sentinels
 * are comments, and a value that closed one would corrupt the byte-range retheming of §4.1),
 * backslash (CSS escape sequences), `@` (at-rules such as `@import`), and every control character
 * including newlines.
 *
 * **Parentheses are rejected too, which bans every functional notation.** Escaping the style
 * element is not the only way a token value does damage: `--sl-bg` is consumed by
 * `background: var(--sl-bg)`, so a value of `url(//evil.example/beacon.png)` — perfectly legal CSS
 * with no `<`, `;`, `@` or comment in it — makes the slide issue an outbound request the instant it
 * renders. That is a deck-open beacon and an IP disclosure from a theme inside an untrusted
 * `.sloodge`, and it contradicts SL-S01 ("zero subresources, zero network/storage APIs") above.
 * Enumerating the fetching functions (`url()`, `image-set()`, `src()`, `element()`, and whatever
 * the next CSS level adds) is exactly the losing game a denylist should not play, and they nest —
 * `image-set(url(x))`, `var(--x, url(x))` — so a name-based rule has to parse CSS to be right.
 * Banning `(` and `)` outright is one character class and needs no parser.
 *
 * **v1 tokens are therefore parenthesis-free: no gradients, no `calc()`, no `var()` fallbacks, no
 * `clamp()`.** Nothing this app emits needs them — colors, lengths, radii and a font stack such as
 * `Inter, 'Segoe UI', sans-serif` all fit. If a later milestone wants gradients, the answer is a
 * structured token type (parse the stops, re-emit them) rather than widening this class.
 *
 * This is a deny-list rather than an allowlist because "any CSS value" is genuinely open —
 * `font-family` alone admits quotes, commas, spaces and non-ASCII — but nothing that survives it
 * can end the style element, the rule, the declaration or the sentinel comment, or fetch.
 */
const THEME_TOKEN_VALUE_FORBIDDEN = /[<>{};@\\()]|\/\*|\*\/|\p{Cc}/u

/** Long enough for a full font stack, short enough that a token cannot be a payload carrier. */
export const MAX_THEME_TOKEN_VALUE_LENGTH = 200

export class ThemeTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThemeTokenError'
  }
}

/**
 * Validate one `--name: value` pair for inlining into a slide's `<style>`.
 *
 * Throws rather than sanitizing. A theme token comes from `theme/theme.json` inside an untrusted
 * `.sloodge` (`ThemeFontsSchema` types `font.sans` as a bare non-empty string and every theme
 * object is a `z.looseObject`, so arbitrary strings reach here the moment a theme-to-token mapper
 * exists). Silently stripping the hostile part would emit a *different* slide than the file
 * describes; refusing means the caller reports a bad theme instead of shipping mangled CSS.
 */
export function assertSafeThemeToken(name: string, value: string): void {
  if (!THEME_TOKEN_NAME_PATTERN.test(name)) {
    throw new ThemeTokenError(`unsafe theme token name: ${JSON.stringify(name)}`)
  }
  if (value.length > MAX_THEME_TOKEN_VALUE_LENGTH) {
    throw new ThemeTokenError(
      `theme token ${name} is ${String(value.length)} chars, over the ${String(MAX_THEME_TOKEN_VALUE_LENGTH)} limit`,
    )
  }
  if (THEME_TOKEN_VALUE_FORBIDDEN.test(value)) {
    throw new ThemeTokenError(`unsafe theme token value for ${name}: ${JSON.stringify(value)}`)
  }
}

export function renderThemeBlock(
  tokens: Readonly<Record<string, string>> = DEFAULT_THEME_TOKENS,
  themeVersion = 1,
): string {
  const declarations = Object.entries(tokens)
    .map(([name, value]) => {
      assertSafeThemeToken(name, value)
      return `    ${name}: ${value};`
    })
    .join('\n')
  return [
    `  /* sl:theme:start v=${String(themeVersion)} */`,
    '  :root {',
    declarations,
    '  }',
    '  /* sl:theme:end */',
  ].join('\n')
}

/** A minimal, contract-compliant blank slide. UTF-8, LF endings, trailing newline. */
export function createStarterSlideHtml(options: StarterSlideOptions): string {
  const title = options.title ?? 'Untitled slide'
  const themeBlock = renderThemeBlock(options.tokens ?? DEFAULT_THEME_TOKENS, options.themeVersion)
  const subtitle =
    options.subtitle === undefined
      ? ''
      : `\n  <p data-sl-id="e_002" class="subtitle">${slideText(options.subtitle)}</p>`

  return `<!doctype html>
<html lang="en" data-sl-slide="${escapeHtml(options.id)}" data-sl-contract="${String(SLIDE_CONTRACT_VERSION)}">
<head>
<meta charset="utf-8">
<title>${slideText(title)}</title>
<style>
${themeBlock}
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--sl-bg); }
  .slide {
    width: ${String(CANVAS_WIDTH)}px;
    height: ${String(CANVAS_HEIGHT)}px;
    overflow: hidden;
    position: relative;
    box-sizing: border-box;
    padding: var(--sl-pad);
    background: var(--sl-bg);
    color: var(--sl-fg);
    font-family: var(--sl-font);
  }
  .title { margin: 0; font-size: 48px; font-weight: 700; line-height: 1.15; }
  .subtitle { margin: 24px 0 0; font-size: 24px; line-height: 1.4; color: var(--sl-muted); }
  [data-sl-freeze] * { animation-play-state: paused !important; }
</style>
</head>
<body>
<div class="slide" data-sl-id="e_root">
  <h1 data-sl-id="e_001" class="title">${slideText(title)}</h1>${subtitle}
</div>
</body>
</html>
`
}

/** The starter speaker-notes file: empty prose, so `notes/<id>.md` exists but says nothing. */
export function createStarterNotes(): string {
  return ''
}
