/**
 * `deck:updated` — the one-way main -> renderer push that hot-updates the canvas and rail as the
 * agent writes (50-agent-integration.md §9; 10-architecture.md §4 names the same seam `doc:changed`).
 *
 * It carries a *serializable snapshot* of the document — manifest plus the id-keyed HTML/notes maps
 * and the theme — deliberately not a `DocPatch`: the shipped renderer owns its deck through
 * `DocumentHistory` (M1.3/M1.4), so it adopts a whole snapshot via `deckStore.applyRemoteDeck`
 * rather than replaying ops against a replica. The op-level `DocPatch` of 10-architecture.md §4
 * belongs to the main-authoritative `DocumentSession` migration, which is a separate milestone; a
 * full snapshot is the honest shape for a renderer that is still the authority today.
 *
 * Dependency-free like the rest of `src/shared`: it re-uses the document types but imports no zod
 * parser and no Electron. The guard is a *shape gate* (main is the trusted sender, same contract as
 * `isAgentEvent`), not a schema validation — `applyRemoteDeck` runs `parseManifest` before it trusts
 * the manifest, so a malformed snapshot is rejected at adoption rather than switched on blindly here.
 */

import type { DeckManifest } from './types'

export type DeckUpdate = {
  readonly manifest: DeckManifest
  /** Slide HTML by slide id — every id in `manifest.slideOrder` should have an entry. */
  readonly slides: Readonly<Record<string, string>>
  /** Speaker notes markdown by slide id; absent key = no notes. */
  readonly notes: Readonly<Record<string, string>>
  /** The parsed theme, or `null` when the deck has none. */
  readonly theme: unknown
}

/**
 * Shape gate for a `deck:updated` payload arriving over IPC. Checks that the three structural fields
 * are objects of the right kind before a listener trusts them; the manifest's *validity* is the
 * adopter's job. Prototype-safe: it never indexes attacker-influenced keys.
 */
export function isDeckUpdate(value: unknown): value is DeckUpdate {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const manifest = record['manifest']
  return (
    typeof manifest === 'object' &&
    manifest !== null &&
    typeof record['slides'] === 'object' &&
    record['slides'] !== null &&
    typeof record['notes'] === 'object' &&
    record['notes'] !== null
  )
}
