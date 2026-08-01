/**
 * Narrow an untyped IPC payload to an `ExportPptxRequest`, or `null` (M4.3). Mirrors
 * `parseExportPdfRequest`: the request crosses the bridge, drives a native save dialog, and writes a
 * file to a user-chosen path, so main re-validates the shape rather than trusting the preload. The
 * only addition over the PDF request is the `fidelity` field.
 */

import type { ExportPptxRequest, PptxFidelity } from './types'
import type { SlideExportInput, SlideRange } from '../types'

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

function parseFidelity(value: unknown): PptxFidelity | null {
  return value === 'auto' || value === 'editable' || value === 'raster' ? value : null
}

export function parseExportPptxRequest(payload: unknown): ExportPptxRequest | null {
  if (payload === null || typeof payload !== 'object') return null
  const { slides, currentIndex, range, deckTitle, fidelity } = payload as {
    slides?: unknown
    currentIndex?: unknown
    range?: unknown
    deckTitle?: unknown
    fidelity?: unknown
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

  const parsedFidelity = parseFidelity(fidelity)
  if (parsedFidelity === null) return null

  return {
    slides: parsedSlides,
    currentIndex,
    range: parsedRange,
    deckTitle,
    fidelity: parsedFidelity,
  }
}
