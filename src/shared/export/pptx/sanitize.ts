/**
 * The XML-1.0 legality rules for every string that ends up inside a `.pptx` — and the single source
 * of truth for what "illegal" means (M4.3, review rounds 1–3).
 *
 * OOXML parts are XML 1.0 documents. pptxgenjs escapes the five metacharacters (`< > & " '`), but it
 * passes the raw code points through otherwise — so an illegal character in agent-authored text lands
 * verbatim in a part (`ppt/slides/slideN.xml`, `ppt/notesSlides/notesSlideN.xml`, `docProps/core.xml`,
 * …), which is **malformed XML**. PowerPoint then treats the whole file as corrupt, and the failure is
 * silent: the zip stays structurally valid, so a slide-count check still reports success.
 *
 * The legal XML-1.0 `Char` production is:
 *   #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 * Everything else is removed: C0 controls other than tab/LF/CR, the `0xFFFE`/`0xFFFF` non-characters,
 * and lone surrogate code units (a valid surrogate *pair*, e.g. an emoji, is kept).
 *
 * ## Where sanitization happens
 *
 * Not here, and not at scattered call sites — rounds 1–3 each found a *new* unsanitized path
 * (slide text → deck metadata → `fontFace`), which is the signature of a rule enforced by vigilance.
 * The enforcement now lives in `main/export/safe-pptx.ts`: the sole module permitted to touch
 * pptxgenjs, which deep-sanitizes **every string** in every value it forwards. This module supplies
 * that adapter (and the tests) with the rules; it does not rely on anyone remembering to call it.
 *
 * `hasXmlIllegalChars` is exported so the test oracle derives its predicate from *these* rules rather
 * than restating them — a narrower duplicate in the test is exactly what hid the `fontFace` hole.
 */

/**
 * C0 controls except 0x09/0x0A/0x0D, plus the non-characters 0xFFFE / 0xFFFF. Built from an escape
 * string via `new RegExp` (rather than a literal with raw control chars) so the source stays readable
 * and copy-safe.
 */
const ILLEGAL_SCALARS_SOURCE = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]'
/** A high surrogate not followed by a low, or a low surrogate not preceded by a high. */
const LONE_SURROGATE_SOURCE =
  '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]'

/** The full illegal set, as one alternation. The single definition both stripping and detection use. */
const ILLEGAL_SOURCE = `${ILLEGAL_SCALARS_SOURCE}|${LONE_SURROGATE_SOURCE}`

/** Remove XML-1.0-illegal characters, preserving all legal text (tab/LF/CR, CJK, emoji pairs). */
export function sanitizeXmlText(text: string): string {
  return text.replace(new RegExp(ILLEGAL_SOURCE, 'g'), '')
}

/**
 * True when `text` contains any XML-1.0-illegal character. The detection half of the same rules
 * `sanitizeXmlText` strips by, exported so the `.pptx` scan in the tests cannot drift narrower than
 * the sanitizer's contract (round 3: a C0-only test regex read a `U+FFFE` part as clean).
 */
export function hasXmlIllegalChars(text: string): boolean {
  return new RegExp(ILLEGAL_SOURCE).test(text)
}

/**
 * Deep-sanitize every string reachable in `value`: strings, arrays, and plain-object property values,
 * recursively. Non-string primitives are returned unchanged.
 *
 * Generic rather than an enumerated field list on purpose — an enumeration is a list someone must
 * remember to extend, and three review rounds each caught a field missing from one. A new pptxgenjs
 * option carrying text is covered automatically the day it is passed.
 */
export function deepSanitizeXmlStrings<T>(value: T): T {
  if (typeof value === 'string') return sanitizeXmlText(value) as T
  if (Array.isArray(value)) return value.map((item) => deepSanitizeXmlStrings(item)) as T
  if (value !== null && typeof value === 'object') {
    // Only plain objects are walked. A Date, Buffer, or class instance walked field-by-field would
    // come back as a bare object and break its consumer, so such values pass through BY IDENTITY —
    // a deliberate choice, safe because nothing on the pptxgenjs surface carries agent text inside a
    // class instance today. Pinned by `sanitize.test.ts`; revisit if that ever changes.
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeXmlText(key)] = deepSanitizeXmlStrings(item)
    }
    return out as T
  }
  return value
}
