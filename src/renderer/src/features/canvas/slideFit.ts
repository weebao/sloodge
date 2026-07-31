/**
 * Scale-to-fit arithmetic for the 1280x720 slide box.
 *
 * A slide document is authored at *exactly* 1280x720 (§3.2 SL-G01 of 30-slide-format.md) and the
 * frame that hosts it keeps those intrinsic pixel dimensions — anything else would change how the
 * slide's own CSS lays out, and a thumbnail would stop being a faithful miniature of the canvas.
 * Fitting is therefore a pure CSS transform applied *outside* the document, which makes the whole
 * problem one function over two rectangles: this one.
 *
 * Kept free of React and of the DOM so the geometry is testable without a layout engine — happy-dom
 * reports every element as 0x0, so component tests can only assert attributes, never pixels.
 */

import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../../../../shared/document/types'

export type Size = { readonly width: number; readonly height: number }

/** The v1 canvas. A constant, not a parameter default, so callers can name it. */
export const SLIDE_SIZE: Size = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }

export type SlideFit = {
  /** CSS `transform: scale()` factor applied to the 1280x720 frame. */
  readonly scale: number
  /** Painted size of the scaled frame, i.e. the letterbox content box, in CSS px. */
  readonly width: number
  readonly height: number
}

export type FitOptions = {
  /** Intrinsic slide size. Overridable so a future non-16:9 canvas (v2) needs no new function. */
  readonly slide?: Size
  /**
   * Upper bound on the scale factor. The canvas passes `1` so a huge window shows the slide at
   * 100% rather than upscaling a 1280px document into a blurry 2000px one; thumbnails never
   * reach it.
   */
  readonly maxScale?: number
}

/**
 * Largest scale at which `slide` fits inside `container`, preserving aspect ratio (letterbox).
 *
 * Degenerate containers collapse to `scale: 0` rather than `NaN`/`Infinity`: a React ref measures
 * 0x0 on the first paint and in every happy-dom test, and `transform: scale(NaN)` is an invalid
 * declaration that silently drops back to unscaled — a 1280px frame bursting out of a 300px rail.
 * Zero is the honest answer ("nothing fits yet") and paints nothing until a real measurement lands.
 */
export function fitSlide(container: Size, options: FitOptions = {}): SlideFit {
  const slide = options.slide ?? SLIDE_SIZE
  const maxScale = options.maxScale ?? Number.POSITIVE_INFINITY
  const usable =
    isPositive(container.width) &&
    isPositive(container.height) &&
    isPositive(slide.width) &&
    isPositive(slide.height) &&
    maxScale > 0
  if (!usable) return { scale: 0, width: 0, height: 0 }

  const scale = Math.min(container.width / slide.width, container.height / slide.height, maxScale)
  return { scale, width: slide.width * scale, height: slide.height * scale }
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}
