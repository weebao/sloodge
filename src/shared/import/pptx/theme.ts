/**
 * `ppt/theme/themeN.xml` → sloodge theme tokens (M4.5).
 *
 * OOXML's colour scheme has twelve slots and sloodge's v1 token set has four, so this is a
 * deliberate projection rather than a translation. The mapping below is the one that makes an
 * imported deck *look* like itself:
 *
 *  | OOXML   | sloodge       | why |
 *  |---------|---------------|-----|
 *  | `lt1`   | `--sl-bg`     | `lt1` is the light background slot; PowerPoint decks are overwhelmingly light-on-dark-text, the opposite of sloodge's built-in dark default, and importing a white deck that renders near-black is not "best effort", it is wrong. |
 *  | `dk1`   | `--sl-fg`     | the body-text slot that pairs with `lt1`. |
 *  | `accent1` | `--sl-accent` | the first accent is what PowerPoint itself uses for emphasis. |
 *  | `dk2`   | `--sl-muted`  | the secondary dark slot, the closest thing to a muted body colour; falls back to `accent2` and then to the built-in default. |
 *
 * The remaining slots (`lt2`, `accent3`..`accent6`, `hlink`, `folHlink`) are parsed and returned so
 * a slide's `schemeClr` reference can resolve to a literal colour, but they get no token: inventing
 * `--sl-accent-4` would put a name in the theme file that nothing in the app consumes.
 *
 * **Every value is re-validated on the way out.** A theme comes from an untrusted archive and its
 * values land in a `<style>` block, so `themeTokens` emits only strings it has matched against a
 * strict hex pattern — never the file's bytes passed through. Anything that fails falls back to the
 * built-in default rather than being sanitized, for the reason `assertSafeThemeToken` gives: a
 * mangled value renders a slide the file does not describe.
 *
 * **Fonts are read and then deliberately discarded** for rendering. The slide contract permits the
 * system font stack only (SL-S03 forbids `@font-face`, and PPTX export embeds font *references* by
 * name so a web font would not survive the round trip anyway). The major/minor typeface names are
 * still returned, and the converter records them in a `data-sl-pptx-font` attribute, so the
 * information is preserved in the document even though it does not drive layout.
 */

import { attribute, descendantsNamed, firstChildNamed, type XmlElement } from '../xml'

/** The twelve `a:clrScheme` slots, in schema order. */
export const SCHEME_COLOR_SLOTS = [
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
] as const

export type SchemeColorSlot = (typeof SCHEME_COLOR_SLOTS)[number]

export type PptxTheme = {
  readonly colors: Readonly<Record<string, string>>
  readonly majorFont: string | null
  readonly minorFont: string | null
}

const HEX6 = /^[0-9a-fA-F]{6}$/

export const FALLBACK_THEME: PptxTheme = {
  colors: Object.freeze(
    Object.assign(Object.create(null) as Record<string, string>, {
      dk1: '#000000',
      lt1: '#ffffff',
      dk2: '#44546a',
      lt2: '#e7e6e6',
      accent1: '#4472c4',
      accent2: '#ed7d31',
      accent3: '#a5a5a5',
      accent4: '#ffc000',
      accent5: '#5b9bd5',
      accent6: '#70ad47',
      hlink: '#0563c1',
      folHlink: '#954f72',
    }),
  ),
  majorFont: null,
  minorFont: null,
}

/**
 * The default `p:clrMap`. A slide says `tx1`/`bg1`; the master's colour map says which scheme slot
 * that means. This is the identity-ish mapping every mainstream deck uses, applied without reading
 * the master — the alternative is threading the master part into every conversion for a value that
 * is this uniform in practice. A deck with an inverted map renders with background and text colours
 * swapped, which is visible and reported rather than silent.
 */
export const DEFAULT_COLOR_MAP: Readonly<Record<string, SchemeColorSlot>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, SchemeColorSlot>, {
    bg1: 'lt1',
    tx1: 'dk1',
    bg2: 'lt2',
    tx2: 'dk2',
    dk1: 'dk1',
    lt1: 'lt1',
    dk2: 'dk2',
    lt2: 'lt2',
    accent1: 'accent1',
    accent2: 'accent2',
    accent3: 'accent3',
    accent4: 'accent4',
    accent5: 'accent5',
    accent6: 'accent6',
    hlink: 'hlink',
    folHlink: 'folHlink',
  }),
)

/**
 * Pull the literal colour out of a scheme slot element. A slot holds exactly one child: `srgbClr`
 * (a literal hex) or `sysClr` (a system colour, whose `lastClr` attribute carries the last value
 * the producing application resolved it to — the only usable answer outside Windows).
 */
function slotColor(slot: XmlElement | undefined): string | null {
  if (!slot) return null
  const srgb = firstChildNamed(slot, 'srgbClr')
  const value = srgb ? attribute(srgb, 'val') : undefined
  if (value !== undefined && HEX6.test(value)) return `#${value.toLowerCase()}`
  const sys = firstChildNamed(slot, 'sysClr')
  const last = sys ? attribute(sys, 'lastClr') : undefined
  if (last !== undefined && HEX6.test(last)) return `#${last.toLowerCase()}`
  return null
}

/** A typeface name we are willing to record. Rejects control characters and absurd lengths. */
function typefaceName(element: XmlElement | undefined): string | null {
  if (!element) return null
  const latin = firstChildNamed(element, 'latin')
  const name = latin ? attribute(latin, 'typeface') : undefined
  if (name === undefined || name === '' || name.length > 128) return null
  // eslint-disable-next-line no-control-regex -- deliberately matching the control range
  if (/\p{Cc}/u.test(name)) return null
  return name
}

export function readTheme(theme: XmlElement): PptxTheme {
  const colors = Object.create(null) as Record<string, string>
  const scheme = descendantsNamed(theme, 'clrScheme')[0]
  for (const slot of SCHEME_COLOR_SLOTS) {
    const resolved = scheme ? slotColor(firstChildNamed(scheme, slot)) : null
    colors[slot] = resolved ?? FALLBACK_THEME.colors[slot] ?? '#000000'
  }

  const fontScheme = descendantsNamed(theme, 'fontScheme')[0]
  return {
    colors,
    majorFont: typefaceName(fontScheme ? firstChildNamed(fontScheme, 'majorFont') : undefined),
    minorFont: typefaceName(fontScheme ? firstChildNamed(fontScheme, 'minorFont') : undefined),
  }
}

/** Resolve a slide-level `schemeClr val=` through the colour map to a literal `#rrggbb`. */
export function resolveSchemeColor(theme: PptxTheme, value: string): string | null {
  const slot = Object.hasOwn(DEFAULT_COLOR_MAP, value)
    ? DEFAULT_COLOR_MAP[value]
    : (SCHEME_COLOR_SLOTS as readonly string[]).includes(value)
      ? (value as SchemeColorSlot)
      : undefined
  if (slot === undefined) return null
  const color = Object.hasOwn(theme.colors, slot) ? theme.colors[slot] : undefined
  return color ?? null
}

/**
 * The `--sl-*` token map for an imported deck. Every value is re-derived from a validated hex
 * string, never passed through from the file, so the result is safe to inline into a `<style>`
 * block — `assertSafeThemeToken` will accept it, and if the theme were hostile it would have failed
 * the hex test long before reaching here.
 */
/** A validated `#rrggbb`, or the fallback. Never the file's bytes passed through. */
function safeHex(value: string | undefined, fallback: string): string {
  return value !== undefined && /^#[0-9a-f]{6}$/.test(value) ? value : fallback
}

export function themeTokens(
  theme: PptxTheme,
  defaults: Readonly<Record<string, string>>,
): Record<string, string> {
  const tokens: Record<string, string> = { ...defaults }
  tokens['--sl-bg'] = safeHex(theme.colors['lt1'], defaults['--sl-bg'] ?? '#ffffff')
  tokens['--sl-fg'] = safeHex(theme.colors['dk1'], defaults['--sl-fg'] ?? '#000000')
  tokens['--sl-accent'] = safeHex(theme.colors['accent1'], defaults['--sl-accent'] ?? '#4472c4')
  tokens['--sl-muted'] = safeHex(
    theme.colors['dk2'] ?? theme.colors['accent2'],
    defaults['--sl-muted'] ?? '#44546a',
  )
  return tokens
}
