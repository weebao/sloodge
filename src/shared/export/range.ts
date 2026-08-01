/**
 * Slide-range parsing and resolution — the wireframe's All / Current / `1-4` control (M4.2), as
 * pure functions so the whole range surface is unit-testable without a deck or a window.
 *
 * Two halves: `parseSlideRangeText` turns the free-text field into a `SlideRange` (or `null` for
 * garbage), and `resolveRange` turns a `SlideRange` plus the deck size into the concrete, ordered,
 * 0-based indices to export. Keeping resolution separate from parsing means a `range` request built
 * programmatically (the default `all` from the menu path) shares the exact clamping logic the typed
 * field does.
 */

import type { SlideRange } from './types'

/**
 * Parse a range field. Accepts `all`, `current`, a single 1-based index (`3`), or an inclusive
 * 1-based span (`1-4`). Whitespace-tolerant and case-insensitive. Returns `null` for anything else
 * — an empty string, a zero or negative bound, a non-numeric token — so the caller can keep the
 * previous valid range rather than export a surprise.
 *
 * A reversed span (`4-1`) is normalized rather than rejected: the user's intent is unambiguous and
 * refusing it would be a worse experience than swapping the bounds.
 */
export function parseSlideRangeText(text: string): SlideRange | null {
  const trimmed = text.trim().toLowerCase()
  if (trimmed === '') return null
  if (trimmed === 'all') return { kind: 'all' }
  if (trimmed === 'current') return { kind: 'current' }

  const single = /^(\d+)$/.exec(trimmed)
  if (single) {
    const n = Number(single[1])
    if (n < 1) return null
    return { kind: 'range', from: n, to: n }
  }

  const span = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed)
  if (span) {
    const a = Number(span[1])
    const b = Number(span[2])
    if (a < 1 || b < 1) return null
    return { kind: 'range', from: Math.min(a, b), to: Math.max(a, b) }
  }

  return null
}

/**
 * The concrete slide indices to export, 0-based and in presentation order.
 *
 * - `all` → every slide.
 * - `current` → just `currentIndex`, when it is in range; `[]` otherwise (a stale index after the
 *   deck shrank must not silently export the wrong slide).
 * - `range` → the inclusive 1-based `from`–`to`, clamped to `[1, total]`. A span entirely past the
 *   end (`50-60` on an 8-slide deck) clamps to empty rather than to the last slide, because
 *   exporting one slide the user did not ask for is more surprising than exporting none.
 *
 * `total` and `currentIndex` are validated defensively: a non-integer or negative `total` yields
 * `[]`, so no caller can turn a malformed count into a `RangeError` from `Array.from`.
 */
export function resolveRange(range: SlideRange, total: number, currentIndex: number): number[] {
  if (!Number.isInteger(total) || total <= 0) return []

  if (range.kind === 'all') {
    return Array.from({ length: total }, (_unused, index) => index)
  }

  if (range.kind === 'current') {
    return Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < total
      ? [currentIndex]
      : []
  }

  // A 1-based inclusive span. Clamp both bounds into [1, total]; if the whole span is off the end,
  // `from > to` after clamping and the loop produces nothing.
  const from = Math.max(1, Math.min(range.from, total + 1))
  const to = Math.min(range.to, total)
  const out: number[] = []
  for (let n = from; n <= to; n += 1) out.push(n - 1)
  return out
}
