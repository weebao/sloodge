/**
 * `perf:run` must measure the deck `deck-hashes.json` describes, or its report is mislabelled: a
 * `perf/decks/` left behind by an older generator would be published under the committed seed and
 * hash. Real files through the shipped writer and reader, because the check is about what is on
 * disk, not about the generator's in-memory output.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateDeck, type DeckHashEntry } from '../../../perf/cli/generate'
import { loadStressDeck } from '../../../perf/cli/run'
import { buildStressDeck, type DeckContent } from '../../../perf/lib/deck'
import { writeDeck } from '../../../src/main/document/store'

const SLIDES = 6
const SEED = 11

/** Change one character of one slide without changing its length. */
function nudge(slides: Record<string, string>, id: string): Record<string, string> {
  const html = slides[id] ?? ''
  const at = html.indexOf('<div')
  return { ...slides, [id]: `${html.slice(0, at + 1)}dvi${html.slice(at + 4)}` }
}

describe('loadStressDeck', () => {
  let dir = ''
  let record: DeckHashEntry

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sloodge-perf-run-'))
    const generated = await generateDeck(dir, SLIDES, SEED)
    record = {
      seed: SEED,
      slideCount: SLIDES,
      contentSha256: generated.contentSha256,
      archiveBytes: generated.archiveBytes,
      totalSlideBytes: generated.totalSlideBytes,
      archetypeCounts: generated.archetypeCounts,
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('accepts the deck the record describes and returns the shipped reader’s bundle', async () => {
    const loaded = await loadStressDeck(dir, record)
    expect(loaded.bundle.manifest.slideOrder).toHaveLength(SLIDES)
    expect(loaded.payloadPath).toBe(join(dir, `stress-${String(SLIDES)}.deck-update.json`))
    expect(loaded.deckReadMs).toBeGreaterThanOrEqual(0)
  })

  it('refuses a payload whose slide content differs from the record by one byte', async () => {
    const payloadPath = join(dir, `stress-${String(SLIDES)}.deck-update.json`)
    const payload = JSON.parse(await readFile(payloadPath, 'utf8')) as DeckContent
    const first = payload.manifest.slideOrder[0] ?? ''
    await writeFile(
      payloadPath,
      JSON.stringify({ ...payload, slides: nudge(payload.slides, first) }),
      'utf8',
    )
    await expect(loadStressDeck(dir, record)).rejects.toThrow(/run pnpm perf:generate/)
  })

  it('refuses a .sloodge whose slides differ from the payload by one byte', async () => {
    // Same length, so a byte-count comparison would pass it; the slides are compared outright.
    const deck = buildStressDeck({ slideCount: SLIDES, seed: SEED })
    const last = deck.manifest.slideOrder[SLIDES - 1] ?? ''
    const written = await writeDeck(join(dir, `stress-${String(SLIDES)}.sloodge`), {
      ...deck,
      slides: nudge(deck.slides, last),
    })
    expect(written.ok).toBe(true)
    await expect(loadStressDeck(dir, record)).rejects.toThrow(/run pnpm perf:generate/)
  })

  it('refuses a record whose hash belongs to another seed', async () => {
    await expect(
      loadStressDeck(dir, { ...record, contentSha256: 'not-the-recorded-digest' }),
    ).rejects.toThrow(/run pnpm perf:generate/)
  })
})
