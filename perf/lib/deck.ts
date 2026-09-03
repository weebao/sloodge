/**
 * Assemble stress slides into a real `.sloodge` deck bundle.
 *
 * "Real" is load-bearing. The bundle produced here goes through the shipped `packDeck`/`writeDeck`
 * (`src/main/document/store.ts`), so it is a genuine ZIP with the STORED `mimetype` entry, a
 * schema-valid `manifest.json`, a theme, and one HTML file per slide. And every slide is checked
 * against the shipped Tier-1 linter (`validateSlideContract`) *before* packing, so a deck that the
 * app would reject can never become a baseline.
 *
 * Determinism: ids are minted from the seed rather than from `crypto`, and every timestamp is a
 * fixed constant. `newSlideId()` in `src/shared/slide-id.ts` draws from `crypto.getRandomValues`
 * with no injection seam, so it cannot be used here — the id builder below reimplements only the
 * *encoding* (Crockford base32, ULID shape) and takes its entropy from the seeded `Rng`. The
 * resulting ids still satisfy `SLIDE_ID_PATTERN`, which is what the manifest schema enforces.
 */

import { createHash } from 'node:crypto'
import { validateSlideContract } from '../../src/shared/document/slide-contract'
import { encodeTime } from '../../src/shared/slide-id'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DEFAULT_THEME_PATH,
  slideFilePath,
  type SlideCapability,
  type Theme,
} from '../../src/shared/document/types'
import {
  ARCHETYPE_CYCLE,
  buildSlideHtml,
  capabilitiesFor,
  DEFAULT_DENSITY,
  kindFor,
  type Archetype,
  type Density,
} from './slides'
import { mulberry32, type Rng } from './prng'

/** Crockford base32, matching `src/shared/slide-id.ts`. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RANDOM_LEN = 16

/**
 * A fixed instant for every generated deck: 2026-01-01T00:00:00Z. Timestamps are part of the
 * manifest and therefore part of the archive bytes, so a wall clock here would break byte-identity
 * between two runs of the same seed.
 */
export const FIXED_TIMESTAMP_MS = 1_767_225_600_000
const FIXED_ISO = new Date(FIXED_TIMESTAMP_MS).toISOString()

/** ULID-shaped id body: 10 chars of encoded time + 16 chars drawn from the seeded `Rng`. */
function ulidBody(rng: Rng): string {
  let out = encodeTime(FIXED_TIMESTAMP_MS)
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out += ENCODING.charAt(Math.floor(rng() * ENCODING.length))
  }
  return out
}

/** The theme every stress deck ships, so slides resolve their `var(--sl-*)` tokens. */
export function stressTheme(rng: Rng): Theme {
  return {
    formatVersion: 1,
    id: `t_${ulidBody(rng)}`,
    name: 'Stress',
    mode: 'dark',
    tokens: {
      color: {
        bg: '#0d1220',
        fg: '#f0f0f5',
        accent: '#4c8dff',
        muted: '#9aa4b8',
      },
      font: {},
      size: {},
      space: {},
    },
    version: 1,
  } as Theme
}

export type StressDeckOptions = {
  /** Number of slides. The roadmap's tiers are 100 / 500 / 1000. */
  readonly slideCount: number
  /** Seed for every varying value. Same seed ⇒ byte-identical deck. */
  readonly seed: number
  readonly density?: Density
  readonly title?: string
}

/** The pieces `packDeck` needs, plus the per-slide archetype map for reporting. */
export type StressDeck = {
  readonly manifest: Record<string, unknown>
  readonly slides: Record<string, string>
  readonly notes: Record<string, string>
  readonly theme: Theme
  readonly extras: Record<string, Uint8Array>
  readonly archetypes: readonly Archetype[]
}

/** Thrown when a generated slide fails the shipped Tier-1 contract. */
export class StressDeckContractError extends Error {
  readonly slideIndex: number
  readonly archetype: Archetype
  readonly detail: string

  constructor(slideIndex: number, archetype: Archetype, detail: string) {
    super(
      `Generated slide ${String(slideIndex)} (${archetype}) fails the slide contract: ${detail}`,
    )
    this.name = 'StressDeckContractError'
    this.slideIndex = slideIndex
    this.archetype = archetype
    this.detail = detail
  }
}

/**
 * Build a complete stress deck.
 *
 * @throws StressDeckContractError if any generated slide fails Tier-1 validation. This is a hard
 *   failure rather than a warning on purpose: the whole value of the harness rests on the decks
 *   being ones the product would actually accept.
 */
export function buildStressDeck(options: StressDeckOptions): StressDeck {
  const {
    slideCount,
    seed,
    density = DEFAULT_DENSITY,
    title = `Stress ${String(slideCount)}`,
  } = options
  if (!Number.isInteger(slideCount) || slideCount <= 0) {
    throw new RangeError(`slideCount must be a positive integer, got ${String(slideCount)}`)
  }

  const rng = mulberry32(seed)
  const theme = stressTheme(rng)

  const slideOrder: string[] = []
  const slides: Record<string, string> = {}
  const notes: Record<string, string> = {}
  const slideEntries: Record<string, unknown> = {}
  const archetypes: Archetype[] = []

  for (let index = 0; index < slideCount; index += 1) {
    const archetype = ARCHETYPE_CYCLE[index % ARCHETYPE_CYCLE.length]
    if (archetype === undefined) throw new Error('archetype cycle is empty')
    const id = `s_${ulidBody(rng)}`
    const html = buildSlideHtml(archetype, id, index, rng, density)
    const capabilities = capabilitiesFor(archetype)

    const result = validateSlideContract(html, capabilities as readonly SlideCapability[])
    if (!result.ok) {
      const detail = result.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `${i.rule}: ${i.message}`)
        .join('; ')
      throw new StressDeckContractError(index, archetype, detail)
    }

    slideOrder.push(id)
    slides[id] = html
    archetypes.push(archetype)
    slideEntries[id] = {
      id,
      file: slideFilePath(id as never),
      title: `${String(index + 1)}. ${archetype}`,
      kind: kindFor(archetype),
      capabilities,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      origin: { type: 'template' },
      hidden: false,
      validation: { status: 'unknown' },
    }
  }

  const manifest: Record<string, unknown> = {
    formatVersion: 1,
    id: `d_${ulidBody(rng)}`,
    title,
    subtitle: `Generated stress deck — seed ${String(seed)}`,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    generator: { app: 'sloodge-perf', version: '1' },
    canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    theme: DEFAULT_THEME_PATH,
    slideOrder,
    slides: slideEntries,
    assets: {},
    presentation: { defaultTransition: 'none', loop: false, showSlideNumbers: true },
  }

  return { manifest, slides, notes, theme, extras: {}, archetypes }
}

/** Total uncompressed HTML bytes, the number that predicts registry pressure and IPC payload size. */
export function totalSlideBytes(deck: StressDeck): number {
  return Object.values(deck.slides).reduce((sum, html) => sum + Buffer.byteLength(html, 'utf8'), 0)
}

/**
 * A stable hash of the deck's *content* — the thing that defines the workload.
 *
 * Deliberately **not** a hash of the `.sloodge` archive. `packDeck` calls fflate's `zipSync` without
 * an `mtime`, so every ZIP local header carries the wall-clock time of the write and two archives of
 * identical content hash differently. That is a property of the shipped writer, not of this
 * generator, and M8.1 is not the milestone to change the product's file writer. Hashing the manifest
 * plus the slide HTML in presentation order captures exactly what the app will render, and is
 * byte-stable across runs, machines and days — which is what M8.2–M8.7 need in order to compare
 * their numbers against this baseline.
 */
export function deckContentHash(deck: StressDeck): string {
  const order = deck.manifest['slideOrder'] as string[]
  const canonical = JSON.stringify({
    manifest: deck.manifest,
    slides: order.map((id) => deck.slides[id] ?? ''),
    notes: deck.notes,
    theme: deck.theme,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
