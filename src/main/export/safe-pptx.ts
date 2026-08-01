/**
 * `SafePptxDeck` — the **sole** module in the codebase permitted to touch pptxgenjs (M4.3, review
 * round 3), and the boundary at which every string is sanitized for XML-1.0 legality.
 *
 * ## Why a boundary instead of another audit
 *
 * Three review rounds each found the same defect class through a different door: slide text (r1), then
 * the deck metadata `pptx.title`/`pptx.author` (r2), then `fontFace` inside a text run's options (r3).
 * Each fix was a correct patch to a *known* path, and each left the next unknown path open — the
 * signature of an invariant maintained by vigilance. The fix is to make the bypass impossible rather
 * than unlikely:
 *
 *  1. **One door.** Nothing else may import or construct pptxgenjs. `tests/unit/export/pptx-boundary.test.ts`
 *     greps the tree and fails if any other module does — the same structural invariant M2.1 uses to
 *     keep `agent/client.ts` the only Agent-SDK importer.
 *  2. **Sanitize generically, not by field list.** Every value forwarded to the library goes through
 *     `deepSanitizeXmlStrings`, which walks strings, arrays and plain objects recursively. A pptxgenjs
 *     option added later — a tooltip, an altText, a bullet character — is covered the day it is
 *     passed, without anyone remembering. An enumerated allow-list is precisely the artefact that
 *     failed three times.
 *
 * The adapter is deliberately thin: it exposes only the pptxgenjs surface the writer actually uses, so
 * the "one door" is also a narrow one. Geometry numbers and enum-ish strings pass through the same
 * sanitizer — a no-op for them, and cheaper than reasoning about which fields "can't" carry text.
 */

import PptxGenJS from 'pptxgenjs'
import { deepSanitizeXmlStrings } from '../../shared/export/pptx/sanitize'

/** A text run as pptxgenjs takes it: the string plus its per-run options. */
export type SafeTextRun = { text: string; options: Record<string, unknown> }

/** The pptxgenjs autoshape names the writer emits. */
export type SafeShapeName = 'rect' | 'roundRect' | 'ellipse' | 'line'

/** The slide handle the writer drives. Every method sanitizes before forwarding. */
export type SafePptxSlide = {
  addText: (runs: readonly SafeTextRun[], options: Record<string, unknown>) => void
  addShape: (shape: SafeShapeName, options: Record<string, unknown>) => void
  addImage: (options: Record<string, unknown>) => void
  addNotes: (notes: string) => void
  setBackground: (background: { color: string } | { data: string }) => void
}

export type SafePptxDeckOptions = {
  layoutName: string
  widthInches: number
  heightInches: number
  author: string
  title: string
}

export type SafePptxDeck = {
  addSlide: () => SafePptxSlide
  write: () => Promise<Uint8Array>
}

/**
 * Create a deck. `author`, `title` and the layout name are sanitized here — they reach
 * `docProps/core.xml`, the r2 hole — and every later call sanitizes its own payload.
 */
export function createSafePptxDeck(options: SafePptxDeckOptions): SafePptxDeck {
  const safe = deepSanitizeXmlStrings(options)
  const pptx = new PptxGenJS()
  pptx.defineLayout({
    name: safe.layoutName,
    width: safe.widthInches,
    height: safe.heightInches,
  })
  pptx.layout = safe.layoutName
  pptx.author = safe.author
  pptx.title = safe.title

  return {
    addSlide: (): SafePptxSlide => {
      const slide = pptx.addSlide()
      return {
        addText: (runs, textOptions): void => {
          // Both halves are sanitized: the run text AND its options object, which is where `fontFace`
          // and `hyperlink.url` live (the r3 hole).
          slide.addText(
            deepSanitizeXmlStrings([...runs]) as {
              text: string
              options: Record<string, unknown>
            }[],
            deepSanitizeXmlStrings(textOptions),
          )
        },
        addShape: (shape, shapeOptions): void => {
          slide.addShape(
            deepSanitizeXmlStrings(shape) as SafeShapeName,
            deepSanitizeXmlStrings(shapeOptions),
          )
        },
        addImage: (imageOptions): void => {
          slide.addImage(deepSanitizeXmlStrings(imageOptions))
        },
        addNotes: (notes): void => {
          // Sanitize *then* test for emptiness: notes consisting only of illegal characters would
          // otherwise emit `addNotes('')` and a pointless empty notesSlide part (r2/r3 nit).
          const safeNotes = deepSanitizeXmlStrings(notes)
          if (safeNotes !== '') slide.addNotes(safeNotes)
        },
        setBackground: (background): void => {
          slide.background = deepSanitizeXmlStrings(background)
        },
      }
    },
    write: async (): Promise<Uint8Array> => {
      const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
    },
  }
}
