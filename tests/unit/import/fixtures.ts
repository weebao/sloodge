/**
 * Shared helpers for the PPTX import / round-trip tests (M4.5, M4.6).
 *
 * The two committed fixtures are deliberately different in provenance:
 *
 *  - **`python-pptx-deck.pptx`** — built by python-pptx 1.0.2, whose default template is a file
 *    authored by Microsoft PowerPoint. 43 parts: a real slide master, eleven slide layouts, a full
 *    theme, placeholder shapes carrying *no* explicit `a:xfrm` (their geometry lives on the layout),
 *    a `docProps/thumbnail.jpeg`, a `ppt/printerSettings/printerSettings1.bin` binary and a
 *    `ppt/tableStyles.xml`. It exercises the importer against a dialect this codebase did not write.
 *  - **`sloodge-export.pptx`** — built by sloodge's own M4.3 export path (pptxgenjs behind the
 *    `SafePptxDeck` boundary). Self-consistent by construction, and the round trip a user is most
 *    likely to perform.
 *
 * Testing only against the second would let the importer and the exporter agree on a shared
 * misreading of OOXML and call it green. Testing only against the first would leave the path users
 * actually take uncovered. Both, therefore.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'pptx',
)

/** Every committed `.pptx` fixture, with the provenance each one exists to cover. */
export const PPTX_FIXTURES = [
  {
    name: 'python-pptx-deck.pptx',
    provenance: 'python-pptx 1.0.2 (PowerPoint-authored default template)',
    /** Slides the presentation declares. */
    slideCount: 3,
  },
  {
    name: 'sloodge-export.pptx',
    provenance: "sloodge's own M4.3 export path (pptxgenjs)",
    slideCount: 2,
  },
] as const

export function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name)
}

export async function readFixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(fixturePath(name)))
}

/**
 * The *file* entries of a zip, excluding directory markers.
 *
 * `unzipSync` reports zero-length `ppt/media/` style entries as members; the hardened reader skips
 * them, because a directory marker is not a part — it carries no content and OPC never references
 * one. pptxgenjs writes them and python-pptx does not, which is itself a nice illustration of why
 * both fixtures exist. Tests count parts, so they must count what the reader counts.
 */
export function filePartNames(entries: Readonly<Record<string, Uint8Array>>): string[] {
  return Object.keys(entries)
    .filter((name) => !name.endsWith('/'))
    .toSorted()
}

/**
 * Text that is legal in HTML (Tier-1 accepts every one of these in slide content) and **illegal in
 * XML 1.0**, so it corrupts an OOXML part if it reaches one unsanitized. Review round 1, blocker 2.
 *
 * Shared so the unit-level splice test and the whole-package round-trip test attack the same set:
 * a battery that lives in one file cannot fall out of step with itself. Every entry is asserted
 * hostile by `hasXmlIllegalChars` before it is used, so a typo cannot turn a case into a no-op.
 */
export const HOSTILE_XML_STRINGS: readonly string[] = [
  'A\u0001B', // C0 control
  'A\u000BB', // vertical tab — legal whitespace in HTML, illegal in XML
  'A\u001FB', // unit separator
  'A\uFFFEB', // non-character
  'A\uFFFFB', // non-character
  'A\uD800B', // lone high surrogate
  'A\uDC00B', // lone low surrogate
  '\u0000 leading NUL',
  'mixed \u0001 and \uFFFE and \uD800 together',
]

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input))
    .digest('hex')
}
