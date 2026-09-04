/**
 * Does a family travel? The one predicate both the export scorer and the property panel ask.
 *
 * It lives here, in the font module, rather than in the PPTX scorer that first needed it, because
 * two features ask the same question of the same data and must not drift apart: `confidence.ts`
 * deducts points for a face PowerPoint may substitute (§3.6), and `FontFamilyControl` warns the user
 * about that same face at the moment they pick it. A warning the export report then contradicted
 * would be worse than no warning at all.
 *
 * It used to live in `export/pptx/confidence.ts`, and the control imported it from there — which put
 * a renderer design-mode component inside the structured exporter's call graph, the thing
 * `tests/unit/export/pptx-rebuild-only.test.ts` exists to forbid (M4.8a). The fix is not to widen
 * that allow-list: font knowledge belongs to the font module, and the exporter reaches in.
 */

/**
 * A conservative system-safe font list (§3.6). Families here map 1:1 into PowerPoint with no
 * substitution risk; anything else keeps its name but takes a confidence penalty and a report note.
 */
const SYSTEM_FONTS: ReadonlySet<string> = new Set(
  [
    'arial',
    'helvetica',
    'helvetica neue',
    'calibri',
    'cambria',
    'georgia',
    'times new roman',
    'times',
    'courier new',
    'courier',
    'verdana',
    'tahoma',
    'trebuchet ms',
    'segoe ui',
    'sans-serif',
    'serif',
    'monospace',
    'system-ui',
    '-apple-system',
    'ui-sans-serif',
    'ui-serif',
    'ui-monospace',
  ].map((f) => f.toLowerCase()),
)

/** The first family in a `font-family` list, unquoted and lower-cased. */
export function firstFontFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0] ?? ''
  return first
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
}

/** True when the (first) family maps into PowerPoint without substitution risk. */
export function isSystemFont(fontFamily: string): boolean {
  return SYSTEM_FONTS.has(firstFontFamily(fontFamily))
}
