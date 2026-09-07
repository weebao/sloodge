import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { importPptx } from '../../../src/main/import/pptx-import'
import { exportPptxRoundTrip } from '../../../src/main/export/pptx-roundtrip'
import { readDeck, writeDeck, type DeckBundle } from '../../../src/main/document/store'
import { fixturePath, PPTX_FIXTURES } from './fixtures'
import type * as rewrite from '../../../src/shared/import/pptx/rewrite'

/**
 * The exporter must not take the splice's word for it (M4.6 review round 5).
 *
 * `rewriteSlideText` reports `ok: true` on the strength of a scanner that can misread a text span's
 * extent, and `exportPptxRoundTrip` used to zip whatever it returned. The refusal in `rewrite.ts`
 * closes the case that was found; this pins the exporter's own check for the case that has not been
 * found yet, by making the splice return a part that does not parse and asserting the export
 * declines rather than shipping it as `patched`. Mutation: remove the `parseXml` call in
 * `exportPptxRoundTrip` and this reds with `mode: 'patched'`.
 */
vi.mock('../../../src/shared/import/pptx/rewrite', async (importOriginal) => {
  const actual = await importOriginal<typeof rewrite>()
  return {
    ...actual,
    rewriteSlideText: (originalXml: string, html: string) => {
      const result = actual.rewriteSlideText(originalXml, html)
      if (!result.ok || result.changedRuns.length === 0) return result
      return { ...result, xml: result.xml.replace('</a:t>', '</a:z>') }
    },
  }
})

const NOW = 1_770_000_000_000

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sloodge-reparse-'))
})

describe('a patched part that does not parse never leaves the exporter', () => {
  it('declines the export instead of shipping the part', async () => {
    const fixture = PPTX_FIXTURES[0]!.name
    const imported = await importPptx(fixturePath(fixture), { now: NOW })
    if (!imported.ok) throw new Error(imported.error.message)
    const deckPath = join(dir, `${fixture}.sloodge`)
    expect((await writeDeck(deckPath, imported.bundle)).ok).toBe(true)
    const reloaded = await readDeck(deckPath)
    if (!reloaded.ok) throw new Error(reloaded.error.message)

    const slideId = reloaded.bundle.manifest.slideOrder[0]!
    const before = reloaded.bundle.slides[slideId]!
    const after = before.replace(
      /(<span[^>]*data-sl-run="0"[^>]*>)([^<]*)(<\/span>)/,
      '$1EDITED THROUGH A LYING SPLICE$3',
    )
    expect(after).not.toBe(before)
    const edited: DeckBundle = {
      ...reloaded.bundle,
      slides: { ...reloaded.bundle.slides, [slideId]: after },
    }

    const result = await exportPptxRoundTrip(edited)
    expect(result.mode).toBe('rebuild')
    expect(result.bytes).toBeNull()
    expect(result.plan.reasons.join(' ')).toContain('does not parse')
  })
})
