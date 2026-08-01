/**
 * The theme-token quick row for M3.8's colour controls (§4.1 of `.claude/plans/init/30-slide-format.md`:
 * "Design Mode's color picker offers theme swatches first"). Pure resolution from the deck's `Theme`
 * to a flat, ordered list of clickable swatches, and from a swatch to the value the panel writes.
 *
 * ## What a swatch click writes, and why it is a `var()` reference
 *
 * §4.1 is explicit that slides are expected to *use* the tokens (`color: var(--sl-fg)`) and that the
 * linter's `SL-T01` suggests replacing a literal with `var(--sl-accent)`; §11 of `40-design-mode.md`
 * settles the open question ("write the token reference instead of a literal? Leaning yes for colors").
 * So a swatch writes the **token reference**, not the resolved hex — which keeps the element re-themeable
 * when the deck's theme changes, the whole point of tokens.
 *
 * The written form is `var(<token>, <hex>)`, where `<token>` is `themeTokenName(key)` — the short-alias
 * custom property the theme block actually defines (see `starter-slide.ts` `DEFAULT_THEME_TOKENS` —
 * `--sl-accent`, not `--sl-color-accent`) — with the **resolved hex as a fallback** so an element still
 * renders the intended colour on a slide that has no inlined `sl:theme` block yet (hand-written slides,
 * or before the theme has been applied). Both halves are pure hex / a validated key, so the result never
 * contains `;`, `{` or `}` and always passes `isSafeStyleValue` at the write chokepoint.
 *
 * ## The reference namespace must equal the declaration namespace
 *
 * A `var()` reference is only worth writing if something can *declare* the name it references, and the
 * only names this app may declare are `THEME_TOKEN_NAME_PATTERN` (`/^--[a-z0-9-]+$/`, lowercase-only).
 * CSS custom-property names are case-sensitive, so a camelCase schema key like `accentFg` must be
 * written `--sl-accent-fg`; `--sl-accentFg` would parse fine and then never resolve, silently freezing
 * the element at its hex fallback and quietly cancelling re-themeability. `themeTokenName` does that
 * normalisation and `isSafeKey` re-checks its output against the very pattern the emitter enforces, so
 * the two modules cannot drift apart without a test going red.
 *
 * ## Key hygiene
 *
 * `ThemeColorsSchema` is `.catchall(hexColor)`, so a forward-compat theme can carry colour keys this
 * build never heard of — and a key is attacker-influenceable document data. Only keys matching
 * `KEY_PATTERN` (and yielding a declarable token name, and bounded in length) become swatches, so a
 * hostile key like `x); color: red; --y: (` can never be spliced into a `var(--sl-…)` reference. The
 * value is re-validated against the deck's own hex pattern too.
 */

import { THEME_TOKEN_NAME_PATTERN } from '../document/starter-slide'
import { HEX_COLOR_PATTERN, type Theme } from '../document/types'

/** One theme colour offered in the quick row: its token key, resolved hex, and a human label. */
export interface ThemeSwatch {
  /** The token key as the theme declares it, e.g. `accent`, `accentFg` or `series-0`. */
  readonly key: string
  /** The resolved hex value — shown as the swatch's colour and used as the `var()` fallback. */
  readonly hex: string
  /** A short label for the swatch's `title`/`aria-label`. */
  readonly label: string
}

/**
 * Only clean token keys become swatches — this is what stops a catchall key from injecting CSS.
 * Case-**sensitive** in its first character: a key must start lowercase, so a shouty `UPPER` catchall
 * key is dropped rather than turned into a custom property no token block may declare. Interior
 * capitals are allowed because the schema itself ships camelCase keys (`accentFg`), which
 * `themeTokenName` normalises to kebab-case below. Bounded in length so a pathological 5000-character
 * key cannot land in the slide source or the accessibility tree.
 */
const KEY_PATTERN = /^[a-z][a-zA-Z0-9-]*$/
const MAX_KEY_LENGTH = 64

/**
 * The CSS custom-property name a token key maps to. **This must land inside the namespace the app is
 * allowed to *declare*** — `THEME_TOKEN_NAME_PATTERN` (`/^--[a-z0-9-]+$/`, enforced by
 * `assertSafeThemeToken`) is lowercase-only, and CSS custom-property names are case-sensitive. So
 * `accentFg` must be written `--sl-accent-fg`, never `--sl-accentFg`: the latter is syntactically
 * fine but no token block this app can emit will ever declare it, leaving the reference permanently
 * dead and silently frozen at its inlined hex fallback — which defeats the whole reason we write a
 * token reference rather than a literal. camelCase is therefore kebab-cased and the whole name is
 * lowercased, matching the mechanical mapping of `30-slide-format.md` §4.4.
 */
export function themeTokenName(key: string): string {
  const kebab = key.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  return `--sl-${kebab}`
}

/**
 * The core colour tokens, in the order the quick row shows them. Exported so a test can assert that
 * **every** key this module ships maps to a declarable custom-property name — the cross-check that
 * keeps the reference namespace and the declaration namespace from drifting apart.
 */
export const CORE_ORDER: readonly (readonly [key: string, label: string])[] = [
  ['bg', 'Background'],
  ['fg', 'Foreground'],
  ['accent', 'Accent'],
  ['accentFg', 'Accent text'],
  ['muted', 'Muted'],
  ['surface', 'Surface'],
  ['border', 'Border'],
  ['ok', 'Success'],
  ['warn', 'Warning'],
  ['danger', 'Danger'],
]

/**
 * The palette shown when the deck has no `theme` yet — the plan's default token block (§4.1 /
 * `starter-slide.ts` `DEFAULT_THEME_TOKENS`), so the quick row is never empty and applying one still
 * writes a `var(--sl-*)` the starter slides actually define.
 */
export const DEFAULT_THEME_SWATCHES: readonly ThemeSwatch[] = [
  { key: 'bg', hex: '#0d1220', label: 'Background' },
  { key: 'fg', hex: '#f0f0f5', label: 'Foreground' },
  { key: 'accent', hex: '#4c8dff', label: 'Accent' },
  { key: 'muted', hex: '#9aa4b8', label: 'Muted' },
]

/**
 * A key is usable only if it is clean *and* the custom-property name it maps to is one a token block
 * may actually declare. The second half is the load-bearing check: it pins this module to
 * `starter-slide.ts`'s emitter, so a key shape that could never be declared is dropped here rather
 * than becoming a silently dead `var()` reference in a slide.
 */
function isSafeKey(key: string): boolean {
  if (key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) return false
  return THEME_TOKEN_NAME_PATTERN.test(themeTokenName(key))
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
}

/**
 * Resolve a deck's theme into the ordered swatch list the quick row renders. Returns the default
 * palette when `theme` is `null`. Core colours come first in a fixed order, then any forward-compat
 * catchall colours (in declaration order), then the categorical `series` palette. Every entry is
 * validated: a non-hex value or an unsafe key is dropped rather than surfaced.
 *
 * **Deduped by token name, not by key.** `themeTokenName` is deliberately many-to-one (it lowercases,
 * so `accentFg` and `accentFG` both name `--sl-accent-fg`), and two swatches that look different but
 * write the identical `var()` reference would be a lie about what clicking them does. First occurrence
 * wins, in the fixed order above, so the choice is deterministic rather than dependent on key
 * enumeration order — and a later colliding key is dropped instead of silently shadowing the earlier
 * one's swatch with its own colour.
 */
export function themeColorSwatches(theme: Theme | null): ThemeSwatch[] {
  if (theme === null) return [...DEFAULT_THEME_SWATCHES]

  const colors = theme.tokens.color as Readonly<Record<string, unknown>>
  const out: ThemeSwatch[] = []
  const seen = new Set<string>()

  const push = (key: string, hex: unknown, label: string): void => {
    if (!isSafeKey(key) || !isHex(hex)) return
    const token = themeTokenName(key)
    if (seen.has(token)) return
    seen.add(token)
    out.push({ key, hex, label })
  }

  for (const [key, label] of CORE_ORDER) push(key, colors[key], label)
  for (const key of Object.keys(colors)) push(key, colors[key], key)

  const series = theme.tokens.series
  if (series !== undefined) {
    for (const [index, hex] of series.entries()) {
      push(`series-${String(index)}`, hex, `Series ${String(index + 1)}`)
    }
  }
  return out
}

/**
 * The value the panel writes when a swatch is clicked: a `var()` reference to the token's short-alias
 * custom property, with the resolved hex as a fallback. See the file header for why this shape.
 */
export function themeSwatchWriteValue(swatch: ThemeSwatch): string {
  return `var(${themeTokenName(swatch.key)}, ${swatch.hex})`
}
