/**
 * Strip XML-1.0-illegal characters from any text bound for the `.pptx` (M4.3 review round 1, MAJOR 1).
 *
 * OOXML parts are XML 1.0 documents. pptxgenjs escapes the five metacharacters (`< > & " '`), but it
 * passes the raw code points through otherwise — so a C0 control character (e.g. `0x01`, or `0x07`
 * BEL) in model-authored slide text lands verbatim inside `ppt/slides/slideN.xml` /
 * `ppt/notesSlides/notesSlideN.xml`, which is **malformed XML**. PowerPoint then treats the whole
 * file as corrupt, and the failure is silent: the zip is still structurally valid, so the slide-count
 * "proof" reports success. This is the single chokepoint every text path (title, body, bullets,
 * hyperlink runs, notes) funnels through in the writer.
 *
 * The legal XML-1.0 `Char` production is:
 *   #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 * Everything else is removed: C0 controls other than tab/LF/CR, the `0xFFFE`/`0xFFFF` non-characters,
 * and lone surrogate code units (a valid surrogate *pair*, e.g. an emoji, is kept).
 */

/**
 * C0 controls except 0x09/0x0A/0x0D, plus the non-characters 0xFFFE / 0xFFFF. Built from an escape
 * string via `new RegExp` (rather than a literal with raw control chars) so the source stays readable
 * and copy-safe.
 */
/* oxlint-disable no-control-regex -- matching control chars is the whole point: we strip them. */
const ILLEGAL_SCALARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]',
  'g',
)
/* oxlint-enable no-control-regex */
/** A high surrogate not followed by a low, or a low surrogate not preceded by a high. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Remove XML-1.0-illegal characters, preserving all legal text (tab/LF/CR, CJK, emoji pairs). */
export function sanitizeXmlText(text: string): string {
  return text.replace(ILLEGAL_SCALARS, '').replace(LONE_SURROGATE, '')
}
