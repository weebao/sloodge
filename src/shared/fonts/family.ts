/**
 * Installed-font family names — from the OS to the stylesheet (M3.10).
 *
 * This module is the whole trust boundary for the font feature. Family names are **attacker-influenced
 * data**: they come from font files on the user's machine, and anyone who can drop a `.ttf` into
 * `%LOCALAPPDATA%\Microsoft\Windows\Fonts` (a per-user directory that needs no admin rights) chooses
 * the `name` table's contents. Those names end up inside a slide's inline CSS, so a name carrying
 * `;`, `}`, `"`, `\`, a newline, `url(`, `expression(` or `</style>` is a CSS/HTML injection vector.
 *
 * The defence is an **allow-list**, not a deny-list, applied where the data enters (the IPC handler)
 * and again where it is composed into CSS. Deny-lists lose this game: `url(` can be written
 * `url\28`, `u\72l(`, or with a comment split. An allow-list of the characters font names actually
 * use cannot be talked around.
 *
 * ## Why the allow-list is Unicode, not `[A-Za-z0-9 ._-]`
 *
 * Measured, not guessed. Parsing the OpenType `name` tables of all 385 font files on the project's
 * Windows 11 host yielded **341 distinct family names**. Their character census:
 *
 *   - the only ASCII punctuation present is `-`, `_`, `.` and space — 17 occurrences in total;
 *   - **zero** names contain `;`, `}`, `"`, `\`, `(`, `<`, `>` or any control character, so a strict
 *     allow-list costs nothing legitimate;
 *   - but 70 of the 341 are not ASCII at all: Katakana (`メイリオ`), CJK ideographs (`宋体`,
 *     `游明朝`), Hangul (`맑은 고딕`) and — 96 occurrences — **fullwidth Latin** (`ＭＳ Ｐゴシック`,
 *     where `Ｐ` is U+FF30, not `P`).
 *
 * An `[A-Za-z0-9 ._-]` allow-list would therefore have silently hidden **20% of the machine's fonts**,
 * every one of them a CJK face. Hence `\p{L}`/`\p{M}`/`\p{Nd}`: those classes cover every real name
 * above while still admitting no CSS metacharacter. The longest real name was 31 characters
 * (`Gill Sans MT Ext Condensed Bold`), so the 128-character cap below is generous headroom rather
 * than a limit anyone will meet.
 *
 * ## What this allow-list knowingly costs
 *
 * Running the real enumerator on that host returns 561 families and this list accepts 515: **46 are
 * dropped**, all of them one installed comic-lettering pack whose names are bracketed
 * (`000 Akbar [TeddyBear]`). They come from `%LOCALAPPDATA%\Microsoft\Windows\Fonts` — the per-user
 * directory that needs no admin rights, which is exactly the directory the threat model above is
 * about. `[` and `]` could be admitted and escaped safely enough, but widening a security allow-list
 * to recover a novelty font pack is the wrong trade: the cost is 8% of one unusual machine's list,
 * and the benefit of a narrow rule is that it stays easy to argue about. Recorded here rather than
 * left for someone to rediscover.
 *
 * ## The second, non-obvious guard: staying inside the slide contract
 *
 * `validateSlideContract` decides SL-S04 by substring-matching forbidden API tokens against the
 * source with **all whitespace stripped** (`html.replace(/\s+/g, '').toLowerCase()`). That makes a
 * family name legal under the character allow-list still able to break the slide: a font called
 * `Local Storage` packs to `localstorage`, and `Document.Cookie` packs to `document.cookie`. Both
 * would turn a Tier-1-valid slide into a Tier-1 *invalid* one the moment the user picked them.
 * SL-G05's viewport-unit regex is reachable the same way (`Display 3vh`).
 *
 * Neither is a plausible accident, which is exactly why it is worth blocking: it is the payload a
 * malicious font would carry. `isContractSafeFontFamilyName` rejects those names at the same
 * boundary, so a slide can never be written into a state its own validator rejects.
 */

// The leaf module, never `slide-contract` itself: this file is reachable from the **preload**
// bundle, which is sandboxed and cannot `require` an external module. Importing the validator would
// drag in parse5 and zod, and the whole preload would fail to load — see `forbidden-apis.ts`.
import { FORBIDDEN_API_TOKENS, packForApiScan } from '../document/forbidden-apis'

/**
 * Longest family name accepted. The longest real name on a stock Windows 11 install is 31
 * characters; 128 leaves room for third-party faces while bounding what can reach slide CSS.
 */
export const MAX_FONT_FAMILY_NAME_LENGTH = 128

/**
 * Most families returned over IPC. A stock Windows 11 host has ~341; a design workstation with
 * Adobe/Google collections installed can reach four figures. 2000 keeps the response small enough
 * to stay well inside the structured-clone budget while never truncating a realistic machine.
 */
export const MAX_SYSTEM_FONT_FAMILIES = 2000

/**
 * The character allow-list. A name must *start* with a letter or digit — so it can never open with
 * `@` (an at-rule sigil), `-` (a custom-property sigil) or whitespace — and may then use letters,
 * combining marks (Vietnamese, Devanagari), digits, space, `.`, `_` and `-`.
 */
const FONT_FAMILY_NAME_PATTERN = /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd} ._-]*$/u

/** SL-G05's viewport-unit test, applied to a name so a face called `Display 3vh` cannot trip it. */
const VIEWPORT_UNIT_PATTERN = /\b\d*\.?\d+(?:vh|vw|vmin|vmax|vi|vb|dvh|dvw|svh|svw|lvh|lvw)\b/i

/**
 * Would writing this name into a slide's CSS make the slide fail its own Tier-1 contract? See the
 * file header — the packing SL-S04 performs means spaces do not separate tokens.
 */
export function isContractSafeFontFamilyName(name: string): boolean {
  // `packForApiScan` comes from the validator's own module rather than being re-implemented here:
  // this guard is only correct while its normalisation is identical to SL-S04's.
  const flat = packForApiScan(name)
  if (FORBIDDEN_API_TOKENS.some((token) => flat.includes(packForApiScan(token)))) return false
  return !VIEWPORT_UNIT_PATTERN.test(name)
}

/**
 * The single predicate every family name must pass before it is shown to the user or written to a
 * slide. Total on `unknown` so it can guard an IPC payload directly.
 */
export function isValidFontFamilyName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_FONT_FAMILY_NAME_LENGTH) return false
  if (!FONT_FAMILY_NAME_PATTERN.test(value)) return false
  return isContractSafeFontFamilyName(value)
}

/**
 * Clean an enumerator's raw output into the list the renderer may show: trim, drop everything that
 * fails the allow-list, fold case-insensitive duplicates (`Arial` and `ARIAL` are one family), sort
 * for a stable dropdown, and cap.
 *
 * Rejects are dropped silently rather than throwing. One malformed name among hundreds must not
 * cost the user the entire font list, and there is no user-actionable report to make about a font
 * file they did not author.
 */
export function normalizeFontFamilies(raw: Iterable<unknown>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of raw) {
    const name = typeof candidate === 'string' ? candidate.trim() : candidate
    if (!isValidFontFamilyName(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  out.sort((a, b) => a.localeCompare(b))
  return out.slice(0, MAX_SYSTEM_FONT_FAMILIES)
}

/** A generic CSS family, the last resort of every stack this module writes. */
export type FontGeneric = 'sans-serif' | 'serif' | 'monospace'

/** One entry of the "system" group the dropdown lists first. */
export interface SystemFontEntry {
  readonly name: string
  readonly generic: FontGeneric
}

/**
 * The faces that survive export. Every one of these is either present on essentially every Windows
 * and macOS machine or is a CSS keyword, so a slide using one renders the same for the recipient —
 * which is what makes them the group worth listing first and the group that raises no warning.
 *
 * This is the dropdown's first *section*, not the definition of "safe". Every entry here is also in
 * the PPTX confidence pass's `SYSTEM_FONTS` (`src/shared/export/pptx/confidence.ts`), but that set
 * is broader — Calibri, Verdana, Tahoma and friends travel too. The export-fidelity warning asks
 * `isSystemFont()` (that broader, already-tested predicate) rather than membership of this list, so
 * picking Verdana from the installed group does not raise a warning the export report would then
 * contradict by scoring it as safe.
 */
export const SYSTEM_FONT_GROUP: readonly SystemFontEntry[] = [
  { name: 'Segoe UI', generic: 'sans-serif' },
  { name: 'Arial', generic: 'sans-serif' },
  { name: 'Helvetica', generic: 'sans-serif' },
  { name: 'Georgia', generic: 'serif' },
  { name: 'Times New Roman', generic: 'serif' },
  { name: 'Courier New', generic: 'monospace' },
  { name: 'system-ui', generic: 'sans-serif' },
]

const SYSTEM_BY_KEY: ReadonlyMap<string, SystemFontEntry> = new Map(
  SYSTEM_FONT_GROUP.map((entry) => [entry.name.toLowerCase(), entry]),
)

/**
 * Is this name already in the system section? Used only to keep a face from appearing twice when
 * the machine also has it installed — not the warning predicate (see `SYSTEM_FONT_GROUP`).
 */
export function isSystemGroupFamily(name: string): boolean {
  return SYSTEM_BY_KEY.has(name.trim().toLowerCase())
}

/**
 * Render a family name as an **escaped CSS identifier sequence** — `Bodoni MT`, `Foo\.Bar` — rather
 * than as a quoted string.
 *
 * ## Why not `"Quoted Name"`, which is what everyone writes by hand
 *
 * Because this value is not going into a stylesheet, it is going into an inline `style="…"`
 * attribute, and the patch layer HTML-escapes what it writes there: `escapeAttrValue` turns `"` into
 * `&quot;` (and `'` into `&#39;`). Both entities **end in a semicolon**, and `parseDeclarations`
 * splits the attribute on semicolons. So `font-family: &quot;Georgia&quot;, serif` reads back as
 * three broken declarations, the first of which is the string `&quot`.
 *
 * That is not cosmetic. Reading the value back gave the panel `&quot` instead of `Georgia`, so it
 * could not recognise its own writes; and the next edit to *any* property on that element would
 * re-serialise the mangled declaration list straight back into the source. A quoted font name in an
 * inline style is a source-corrupting write in this codebase, so this composer does not produce one.
 *
 * An identifier sequence avoids quotes entirely. It is exactly as valid: CSS lets a family name be a
 * run of space-separated identifiers, and every code point at or above U+0080 is an identifier code
 * point, so the CJK and fullwidth names go through untouched and unescaped.
 *
 * ## The escaping
 *
 * Deliberately **independent of `isValidFontFamilyName`** rather than trusting it — composition and
 * validation are two guards, and a guard that only holds because another guard ran is one guard.
 * Handed `Evil"; } body { x: url(//h)` directly, this still yields something inert.
 *
 * Anything that is not an identifier code point is escaped: with a backslash when the character is
 * unambiguous on its own (`\.`), and as a hex escape with its terminating space (CSS Syntax §4.3.7)
 * when a bare backslash would not be — a hex digit, which would otherwise be absorbed into the
 * escape, or a newline, which cannot follow a backslash at all. Spaces stay literal because they are
 * the separator between the identifiers of one family name, and escaping them would turn readable
 * source into `Segoe\ UI` for no gain.
 */
export function cssIdentFontFamily(name: string): string {
  let out = ''
  for (const character of name) {
    // A plain space is the separator between the identifiers of one family name; it is the only
    // whitespace that stays literal.
    if (character === ' ') {
      out += character
      continue
    }
    // The hex-escape test runs *before* the identifier test. CSS calls every code point at or above
    // U+0080 an identifier code point, which would wave through U+2028/U+2029 and the exotic spaces
    // — separators a parser may still treat as a line break.
    if (NEEDS_HEX_ESCAPE.test(character)) {
      out += `\\${character.codePointAt(0)!.toString(16)} `
      continue
    }
    if (IDENT_CODE_POINT.test(character)) {
      out += character
      continue
    }
    // A bare `\x` escape is only unambiguous when `x` is not a hex digit, which would otherwise be
    // absorbed into the escape sequence.
    out += HEX_DIGIT.test(character)
      ? `\\${character.codePointAt(0)!.toString(16)} `
      : `\\${character}`
  }
  // An identifier may not begin with a digit, so a face called `1979 Sans` has to escape its first
  // character to stay a name rather than a parse error. The escape carries the character's *own*
  // code point: `\p{Nd}` is not just `0`-`9`, and a hardcoded `\\3` prefix would turn a leading
  // `\u0663` into `\\3\u0663`, i.e. U+0003 — a font that cannot exist and a name the panel could not
  // read back. Sliced by code point too, so a non-BMP digit (`\u{1D7CE} Sans`) cannot leave a lone
  // surrogate in slide source.
  if (!/^\p{Nd}/u.test(out)) return out
  const first = String.fromCodePoint(out.codePointAt(0)!)
  return `\\${first.codePointAt(0)!.toString(16)} ${out.slice(first.length)}`
}

/** Letters, marks, digits, `_`, `-`, and everything from U+0080 up (CSS Syntax §4.2). */
const IDENT_CODE_POINT = /[\p{L}\p{M}\p{Nd}_\u{0080}-\u{10FFFF}-]/u
const HEX_DIGIT = /[0-9a-fA-F]/
/** Controls, format characters, and every flavour of separator — but not the plain space above. */
const NEEDS_HEX_ESCAPE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\s]/u

/**
 * Family names that CSS would read as something other than a family if written bare. `serif` the
 * installed face and `serif` the generic keyword are indistinguishable unquoted, so the first
 * character is hex-escaped to force identifier interpretation. `system-ui` is absent on purpose —
 * there we *want* the keyword.
 */
const RESERVED_FAMILY_WORDS: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'math',
  'emoji',
  'fangsong',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
])

/**
 * The full `font-family` value for a picked face, or `null` if the name is not one we will write.
 *
 * The stack is `Chosen Face, Segoe UI, system-ui, sans-serif`: the pick, then the two faces most
 * likely to exist on a machine that lacks it, then the generic. `Segoe UI`/`system-ui` are omitted
 * for serif and monospace picks — a sans-serif fallback ahead of the generic would always win, so
 * leaving them in would mean a missing `Georgia` silently rendered as sans-serif rather than as the
 * serif the author asked for.
 *
 * `system-ui` is a CSS keyword rather than a family name, so picking it writes the keyword alone.
 */
export function buildFontFamilyValue(name: string): string | null {
  const trimmed = name.trim()
  if (!isValidFontFamilyName(trimmed)) return null

  const key = trimmed.toLowerCase()
  const generic: FontGeneric = SYSTEM_BY_KEY.get(key)?.generic ?? 'sans-serif'
  if (key === 'system-ui') return `system-ui, ${generic}`

  const ident = cssIdentFontFamily(trimmed)
  const head = RESERVED_FAMILY_WORDS.has(key)
    ? `\\${trimmed.codePointAt(0)!.toString(16)} ${ident.slice(1)}`
    : ident
  const tail = generic === 'sans-serif' ? ['Segoe UI', 'system-ui', generic] : [generic]
  return [head, ...tail].join(', ')
}

/**
 * Recover the picked face from a `font-family` value already in a slide, so the dropdown can show
 * what is selected. Reads only the first family and unwraps one layer of CSS quoting; a value we
 * would not have written (a raw cascade value, a webfont stack) still yields its first family, which
 * is the right thing to highlight.
 *
 * Handles both shapes it can meet: the escaped identifier `buildFontFamilyValue` writes, and the
 * quoted string a human author (or an AI edit) would have written by hand. The entity decode covers
 * the latter — an author-written `"Segoe UI"` reaches the source as `&quot;Segoe UI&quot;` — and
 * `&amp;` is decoded last so a literal `&amp;quot;` does not turn into a quote.
 */
export function readPickedFontFamily(value: string | null): string | null {
  if (value === null) return null
  const decoded = value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  const first = decoded.split(',')[0]?.trim() ?? ''
  const quoted =
    first.length >= 2 &&
    ((first.startsWith('"') && first.endsWith('"')) ||
      (first.startsWith("'") && first.endsWith("'")))
  const body = quoted ? first.slice(1, -1) : first
  return unescapeCssIdent(body).trim() || null
}

/** Reverse of `cssIdentFontFamily`: `\.` and `\2e ` both come back as `.`. */
function unescapeCssIdent(value: string): string {
  return value.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ ]?|(.))/g,
    (_match, hex: string, literal: string) =>
      hex === undefined ? literal : String.fromCodePoint(Number.parseInt(hex, 16)),
  )
}
