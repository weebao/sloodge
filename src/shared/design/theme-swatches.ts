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
 * The written form is `var(--sl-<key>, <hex>)`: the short-alias custom property the theme block actually
 * defines (see `starter-slide.ts` `DEFAULT_THEME_TOKENS` — `--sl-accent`, not `--sl-color-accent`), with
 * the **resolved hex as a fallback** so an element still renders the intended colour on a slide that has
 * no inlined `sl:theme` block yet (hand-written slides, or before the theme has been applied). Both
 * halves are pure hex / a validated key, so the result never contains `;`, `{` or `}` and always passes
 * `isSafeStyleValue` at the write chokepoint.
 *
 * ## Key hygiene
 *
 * `ThemeColorsSchema` is `.catchall(hexColor)`, so a forward-compat theme can carry colour keys this
 * build never heard of — and a key is attacker-influenceable document data. Only keys matching
 * `KEY_PATTERN` become swatches, so a hostile key like `x); color: red; --y: (` can never be spliced
 * into a `var(--sl-…)` reference. The value is re-validated against the deck's own hex pattern too.
 */

import { HEX_COLOR_PATTERN, type Theme } from '../document/types'

/** One theme colour offered in the quick row: its token key, resolved hex, and a human label. */
export interface ThemeSwatch {
  /** The token key, e.g. `accent` or `series-0`. Written into `var(--sl-<key>, …)`. */
  readonly key: string
  /** The resolved hex value — shown as the swatch's colour and used as the `var()` fallback. */
  readonly hex: string
  /** A short label for the swatch's `title`/`aria-label`. */
  readonly label: string
}

/** Only clean token keys become swatches — this is what stops a catchall key from injecting CSS. */
const KEY_PATTERN = /^[a-z][a-z0-9-]*$/i

/** The core colour tokens, in the order the quick row shows them. */
const CORE_ORDER: readonly (readonly [key: string, label: string])[] = [
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

function isSafeKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value)
}

/**
 * Resolve a deck's theme into the ordered swatch list the quick row renders. Returns the default
 * palette when `theme` is `null`. Core colours come first in a fixed order, then any forward-compat
 * catchall colours (in declaration order), then the categorical `series` palette. Every entry is
 * validated: a non-hex value or an unsafe key is dropped rather than surfaced.
 */
export function themeColorSwatches(theme: Theme | null): ThemeSwatch[] {
  if (theme === null) return [...DEFAULT_THEME_SWATCHES]

  const colors = theme.tokens.color as Readonly<Record<string, unknown>>
  const out: ThemeSwatch[] = []
  const seen = new Set<string>()

  const push = (key: string, hex: unknown, label: string): void => {
    if (seen.has(key) || !isSafeKey(key) || !isHex(hex)) return
    seen.add(key)
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
  return `var(--sl-${swatch.key}, ${swatch.hex})`
}
