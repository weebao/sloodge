/**
 * OPC (Open Packaging Conventions) inspection of a produced `.pptx` (M4.3). A `.pptx` is a zip; this
 * reads back its structure so the export report's `emittedSlideCount` is *proof the file is real*
 * rather than a claim — exactly as the PDF path reads `pageCount` from the finished PDF. Uses fflate
 * (already a dependency), so it is pure and unit-testable, and it is the same check the OPC-validity
 * tests run against the writer's output.
 */

import { unzipSync } from 'fflate'

/** List every part path in the package. Throws if the bytes are not a valid zip. */
export function pptxParts(bytes: Uint8Array): string[] {
  return Object.keys(unzipSync(bytes))
}

/** Count `ppt/slides/slideN.xml` parts — the number of slides actually written to the deck. */
export function pptxSlideCount(bytes: Uint8Array): number {
  return pptxParts(bytes).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).length
}

/** True when the package carries the mandatory `[Content_Types].xml` and at least one slide part. */
export function isValidPptx(bytes: Uint8Array): boolean {
  try {
    const parts = pptxParts(bytes)
    return (
      parts.includes('[Content_Types].xml') &&
      parts.some((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    )
  } catch {
    return false
  }
}
