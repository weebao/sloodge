/**
 * `pnpm perf:generate` — write the stress decks.
 *
 * Emits, per size tier, both artifacts the harness needs:
 *  - `<name>.sloodge` — a real ZIP written by the shipped `writeDeck`, so it is openable by the app
 *    (and by any unzip tool) rather than a harness-private format.
 *  - `<name>.deck-update.json` — the same content shaped as a `DeckUpdate`, which is what the
 *    session pushes over the production `deck:updated` channel. It is written to disk rather than
 *    injected as a string because a 1000-slide deck is ~18 MB and embedding that in a
 *    `Runtime.evaluate` expression is a needlessly large WebSocket frame.
 *
 * Generated decks are **not committed** — they are large and exactly reproducible from the seed.
 * `deck-hashes.json` is committed instead, so a later run can prove it regenerated the same content.
 *
 * The recorded hash is a **content** hash, not a hash of the `.sloodge` file: `packDeck` writes ZIP
 * local headers without a fixed `mtime`, so two archives holding identical slides differ byte-wise.
 * `archiveBytes` is still recorded and *is* stable, since the timestamp lives in an uncompressed
 * header field.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildStressDeck, deckContentHash, totalSlideBytes, type StressDeck } from '../lib/deck'
import { writeDeck } from '../../src/main/document/store'
import type { DeckBundle } from '../../src/main/document/store'

export const DEFAULT_SEED = 20260801
export const DEFAULT_SIZES: readonly number[] = [100, 500, 1000]

export type GeneratedDeck = {
  readonly slideCount: number
  readonly seed: number
  readonly sloodgePath: string
  readonly payloadPath: string
  readonly archiveBytes: number
  readonly totalSlideBytes: number
  readonly contentSha256: string
  readonly archetypeCounts: Readonly<Record<string, number>>
}

function archetypeCounts(deck: StressDeck): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const archetype of deck.archetypes) {
    counts[archetype] = (counts[archetype] ?? 0) + 1
  }
  return counts
}

export async function generateDeck(
  outDir: string,
  slideCount: number,
  seed: number,
): Promise<GeneratedDeck> {
  const deck = buildStressDeck({ slideCount, seed })
  const bundle: DeckBundle = {
    manifest: deck.manifest,
    slides: deck.slides,
    notes: deck.notes,
    theme: deck.theme,
    extras: deck.extras,
  }

  const name = `stress-${String(slideCount)}`
  const sloodgePath = join(outDir, `${name}.sloodge`)
  const payloadPath = join(outDir, `${name}.deck-update.json`)

  const written = await writeDeck(sloodgePath, bundle)
  if (!written.ok) {
    throw new Error(`writeDeck refused the generated deck: ${JSON.stringify(written.error)}`)
  }

  // The `DeckUpdate` shape `applyRemoteDeck` expects: manifest + id-keyed maps + theme.
  const payload = {
    manifest: deck.manifest,
    slides: deck.slides,
    notes: deck.notes,
    theme: deck.theme,
  }
  const payloadJson = JSON.stringify(payload)
  await writeFile(payloadPath, payloadJson, 'utf8')

  const archiveBytes = (await stat(sloodgePath)).size

  return {
    slideCount,
    seed,
    sloodgePath,
    payloadPath,
    archiveBytes,
    totalSlideBytes: totalSlideBytes(deck),
    contentSha256: deckContentHash(deck),
    archetypeCounts: archetypeCounts(deck),
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const repoRoot = process.cwd()
  const outDir = join(repoRoot, 'perf', 'decks')
  await mkdir(outDir, { recursive: true })

  const sizeArg = argv.find((a) => a.startsWith('--sizes='))
  const seedArg = argv.find((a) => a.startsWith('--seed='))
  const sizes =
    sizeArg === undefined
      ? DEFAULT_SIZES
      : sizeArg
          .slice('--sizes='.length)
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
  const seed = seedArg === undefined ? DEFAULT_SEED : Number(seedArg.slice('--seed='.length))

  const results: GeneratedDeck[] = []
  for (const size of sizes) {
    const started = Date.now()
    const result = await generateDeck(outDir, size, seed)
    results.push(result)
    console.log(
      `${String(size).padStart(5)} slides  ` +
        `archive ${(result.archiveBytes / 1_048_576).toFixed(1)} MB  ` +
        `html ${(result.totalSlideBytes / 1_048_576).toFixed(1)} MB  ` +
        `${String(Date.now() - started)} ms  ` +
        `content ${result.contentSha256.slice(0, 12)}`,
    )
  }

  const hashes = Object.fromEntries(
    results.map((r) => [
      `stress-${String(r.slideCount)}`,
      {
        seed: r.seed,
        slideCount: r.slideCount,
        contentSha256: r.contentSha256,
        archiveBytes: r.archiveBytes,
        totalSlideBytes: r.totalSlideBytes,
        archetypeCounts: r.archetypeCounts,
      },
    ]),
  )
  await writeFile(
    join(repoRoot, 'perf', 'deck-hashes.json'),
    `${JSON.stringify(hashes, null, 2)}\n`,
    'utf8',
  )
  console.log(`\nWrote perf/deck-hashes.json (${String(results.length)} decks).`)
}
