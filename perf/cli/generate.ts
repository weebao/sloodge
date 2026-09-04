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

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildStressDeck, deckContentHash, totalSlideBytes, type StressDeck } from '../lib/deck'
import { writeDeck } from '../../src/main/document/store'
import type { DeckBundle } from '../../src/main/document/store'

export const DEFAULT_SEED = 20260801
/** Every committed tier, so a plain `pnpm perf:generate` regenerates the whole record. */
export const DEFAULT_SIZES: readonly number[] = [25, 50, 100, 200, 300, 500, 1000]

export type DeckHashEntry = {
  readonly seed: number
  readonly slideCount: number
  readonly contentSha256: string
  readonly archiveBytes: number
  readonly totalSlideBytes: number
  readonly archetypeCounts: Readonly<Record<string, number>>
}

export type DeckHashes = Readonly<Record<string, DeckHashEntry>>

/**
 * Tiers whose committed record carries a different seed than the one about to be generated.
 *
 * `deck-hashes.json` is the proof that M8.2–M8.7 measured the same workload, so `--seed=1` must not
 * quietly replace the record for `stress-100` while every committed baseline still says 20260801.
 * Checked before any deck is built, so the refusal costs nothing.
 */
export function seedConflicts(
  existing: DeckHashes,
  sizes: readonly number[],
  seed: number,
): readonly string[] {
  return sizes.flatMap((slideCount) => {
    const key = `stress-${String(slideCount)}`
    const prior = existing[key]
    return prior === undefined || prior.seed === seed
      ? []
      : [`${key} is recorded with seed ${String(prior.seed)}, requested ${String(seed)}`]
  })
}

/**
 * Fold freshly generated entries into the committed record, keeping every tier that was not
 * regenerated. A routine `perf:generate --sizes=100` used to rewrite the file with one entry.
 */
export function mergeDeckHashes(
  existing: DeckHashes,
  generated: readonly GeneratedDeck[],
): DeckHashes {
  const merged: Record<string, DeckHashEntry> = { ...existing }
  for (const r of generated) {
    merged[`stress-${String(r.slideCount)}`] = {
      seed: r.seed,
      slideCount: r.slideCount,
      contentSha256: r.contentSha256,
      archiveBytes: r.archiveBytes,
      totalSlideBytes: r.totalSlideBytes,
      archetypeCounts: r.archetypeCounts,
    }
  }
  return Object.fromEntries(
    Object.entries(merged).toSorted(([, a], [, b]) => a.slideCount - b.slideCount),
  )
}

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
  const force = argv.includes('--force')

  const hashPath = join(repoRoot, 'perf', 'deck-hashes.json')
  const existing = JSON.parse(await readFile(hashPath, 'utf8').catch(() => '{}')) as DeckHashes
  const conflicts = seedConflicts(existing, sizes, seed)
  if (conflicts.length > 0 && !force) {
    throw new Error(
      `Refusing to overwrite perf/deck-hashes.json: ${conflicts.join('; ')}. ` +
        'Pass --force to replace the committed record.',
    )
  }

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

  const hashes = mergeDeckHashes(existing, results)
  await writeFile(hashPath, `${JSON.stringify(hashes, null, 2)}\n`, 'utf8')
  console.log(
    `\nWrote perf/deck-hashes.json (${String(results.length)} regenerated, ` +
      `${String(Object.keys(hashes).length)} recorded).`,
  )
}
