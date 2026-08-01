/**
 * The coordinate mapping for PPTX export (M4.3 / 60-export.md §3.7): 1280×720 CSS px → PowerPoint's
 * absolute-positioned world. Pure, so the one conversion the whole structured walk depends on is
 * asserted by a unit test rather than trusted to a call site.
 *
 * ## Why the mapping is exact
 *
 * A slide is a self-contained 1280×720 document (30-slide-format.md §0). At Chromium's 96 dpi
 * baseline that is exactly 13.333…in × 7.5in — PowerPoint's 16:9 "widescreen" size — so **no scaling
 * is ever needed**. `px / 96 = inches` is the only conversion, and it is exact. pptxgenjs takes inches
 * for `x/y/w/h`, but OOXML's native unit is the EMU (English Metric Unit, 914400 per inch); since
 * 914400 / 96 = 9525 is an integer, `px → EMU` is `px * 9525` with no rounding at all — a fact the
 * mutation tests lean on, because a wrong factor there mis-places every shape on every slide.
 */

import { CSS_PX_PER_INCH, PDF_POINTS_PER_INCH } from '../types'
import type { BoxInches } from './types'

/** OOXML English Metric Units per inch. The native unit of every position in a `.pptx`. */
export const EMU_PER_INCH = 914400
/** EMU per CSS px: 914400 / 96 = 9525, exactly (no fractional part), so `px → EMU` never rounds. */
export const EMU_PER_CSS_PX = EMU_PER_INCH / CSS_PX_PER_INCH

/** CSS px → inches. `px / 96`. Exact and DPR-independent — pptxgenjs positions are in inches. */
export function pxToInches(px: number): number {
  return px / CSS_PX_PER_INCH
}

/** CSS px → EMU. `px * 9525`, integer-exact. The OOXML-native form of {@link pxToInches}. */
export function pxToEmu(px: number): number {
  return px * EMU_PER_CSS_PX
}

/** CSS px → points (pt), for font sizes: `px * 0.75` (96 dpi → 72 pt/in). */
export function pxToPoints(px: number): number {
  return (px * PDF_POINTS_PER_INCH) / CSS_PX_PER_INCH
}

/** Map a device/CSS-px box (as measured by `getBoundingClientRect`) into a pptxgenjs inch box. */
export function boxToInches(box: { x: number; y: number; w: number; h: number }): BoxInches {
  return {
    x: pxToInches(box.x),
    y: pxToInches(box.y),
    w: pxToInches(box.w),
    h: pxToInches(box.h),
  }
}
