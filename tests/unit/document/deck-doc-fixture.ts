/**
 * Shared fixtures for the M1.2 command-layer tests. Not a `*.test.ts` file, so vitest does not
 * collect it (see `vitest.config.ts` `include`).
 */

import { addSlide, createEmptyDeck, createSlideEntry } from '../../../src/shared/document/deck'
import type { DeckDoc } from '../../../src/shared/document/commands'
import { createSlideId } from '../../../src/shared/slide-id'
import type { SlideId, Theme } from '../../../src/shared/document/types'

export const T0 = 1_770_000_000_000

/** Null-prototype, like everything the command layer and the store produce. */
export function map<T>(entries: Readonly<Record<string, T>>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>
  for (const key of Object.keys(entries)) out[key] = entries[key]!
  return out
}

export function makeTheme(overrides: Partial<Theme> = {}): Theme {
  return {
    formatVersion: 1,
    id: `t_${createSlideId(T0)}`,
    name: 'Fixture theme',
    mode: 'dark',
    tokens: {
      color: { bg: '#0d1220', fg: '#f0f0f5', accent: '#4c8dff', muted: '#9aa4b8' },
      font: { sans: 'Inter' },
      size: { body: 22 },
      space: { pad: 48 },
    },
    version: 1,
    ...overrides,
  }
}

export type Fixture = { doc: DeckDoc; ids: SlideId[] }

/**
 * A deck of `count` slides, every one with HTML and (by default) notes — i.e. the consistent
 * document shape `readDeck` produces for an intact `.sloodge`.
 */
export function makeDoc(count: number, options: { notes?: boolean; theme?: Theme | null } = {}) {
  const withNotes = options.notes ?? true
  let manifest = createEmptyDeck({ now: T0, title: 'Fixture deck' })
  const ids: SlideId[] = []
  const slides: Record<string, string> = Object.create(null) as Record<string, string>
  const notes: Record<string, string> = Object.create(null) as Record<string, string>
  for (let index = 0; index < count; index += 1) {
    const entry = createSlideEntry({
      now: T0 + index,
      title: `Slide ${String(index + 1)}`,
      withNotes,
    })
    manifest = addSlide(manifest, entry)
    ids.push(entry.id)
    slides[entry.id] = `<main class="slide">${String(index + 1)}</main>`
    if (withNotes) notes[entry.id] = `notes for slide ${String(index + 1)}`
  }
  const theme = options.theme ?? null
  if (theme !== null) manifest = { ...manifest, theme: 'theme/theme.json' }
  const doc: DeckDoc = { manifest, slides, notes, theme }
  return { doc, ids }
}
