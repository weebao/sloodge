/**
 * Narrow an untyped IPC payload to an `ExportPdfRequest`, or `null` (M4.2).
 *
 * The request crosses the bridge from the renderer, so main re-validates it rather than trusting the
 * preload's screen — the same discipline `slide:publish` uses (`registry.ts`). An export drives a
 * native save dialog and writes a file to a user-chosen path, so a malformed payload must be dropped
 * before any of that, not coerced.
 *
 * HTML byte limits are *not* enforced here: each slide is published through the same `SlideRegistry`
 * as the editor canvas, whose `publish` applies `MAX_SLIDE_HTML_BYTES` and the aggregate caps. This
 * function only proves the shape.
 */

import type { ExportPdfRequest, SlideExportInput, SlideRange } from './types'

function parseSlideRange(value: unknown): SlideRange | null {
  if (value === null || typeof value !== 'object') return null
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'all') return { kind: 'all' }
  if (kind === 'current') return { kind: 'current' }
  if (kind === 'range') {
    const { from, to } = value as { from?: unknown; to?: unknown }
    if (
      typeof from === 'number' &&
      typeof to === 'number' &&
      Number.isFinite(from) &&
      Number.isFinite(to)
    ) {
      return { kind: 'range', from, to }
    }
  }
  return null
}

function parseSlide(value: unknown): SlideExportInput | null {
  if (value === null || typeof value !== 'object') return null
  const { title, html } = value as { title?: unknown; html?: unknown }
  if (typeof title !== 'string' || typeof html !== 'string') return null
  return { title, html }
}

export function parseExportPdfRequest(payload: unknown): ExportPdfRequest | null {
  if (payload === null || typeof payload !== 'object') return null
  const { slides, currentIndex, range, deckTitle } = payload as {
    slides?: unknown
    currentIndex?: unknown
    range?: unknown
    deckTitle?: unknown
  }

  if (!Array.isArray(slides)) return null
  const parsedSlides: SlideExportInput[] = []
  for (const slide of slides) {
    const parsed = parseSlide(slide)
    if (parsed === null) return null
    parsedSlides.push(parsed)
  }

  if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex)) return null

  const parsedRange = parseSlideRange(range)
  if (parsedRange === null) return null

  if (typeof deckTitle !== 'string') return null

  return { slides: parsedSlides, currentIndex, range: parsedRange, deckTitle }
}
