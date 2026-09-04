/**
 * The fixture corpus, with the load-bearing constructs each slide is *declared* to carry. Text nodes,
 * painted boxes and pseudo-elements are not declared here — the ground-truth script (`truth.ts`)
 * discovers them — but rotations and a painted body background are, because "did the exporter keep
 * it" is only checkable against a statement of what was there.
 *
 * Slides `01`–`08` are research/pptx-export-fidelity.md §0. Slides `x1`–`x6` were written by the r1
 * reviewer *against* the finished exporter, not alongside it: each one reproduced a construct that
 * scored 90+ while vanishing from the `.pptx`. They are in the corpus so the next tuning pass cannot
 * quietly fit the scorer to the eight slides it was born with.
 */

import type { MeasureResult } from '../../../src/shared/export/pptx/node'
import type { GroundTruth } from './truth'

export type ExpectedRotation = {
  /** A substring of the rotated element's text, to find its emitted shape. */
  text: string
  /** The authored CSS `rotate()` angle in degrees, clockwise positive. */
  deg: number
}

export type CorpusSlide = {
  file: string
  rotations: readonly ExpectedRotation[]
  /** True when `body` paints a gradient/image background that must survive (as `<p:bg>` or a picture). */
  bodyImage: boolean
}

export const CORPUS: readonly CorpusSlide[] = [
  { file: '01-title-body.html', rotations: [], bodyImage: false },
  { file: '02-columns.html', rotations: [], bodyImage: false },
  { file: '03-absolute.html', rotations: [], bodyImage: false },
  { file: '04-svg-chart.html', rotations: [], bodyImage: false },
  { file: '05-gradient-cards.html', rotations: [], bodyImage: true },
  { file: '06-grid-flex.html', rotations: [], bodyImage: false },
  {
    file: '07-rotated.html',
    rotations: [
      { text: 'CONFIDENTIAL', deg: -14 },
      { text: 'Rotated elements', deg: 3 },
      { text: 'INTERNAL ONLY', deg: 90 },
    ],
    bodyImage: false,
  },
  { file: '08-webfont.html', rotations: [], bodyImage: false },
  // Out-of-corpus probes from review r1, promoted to fixtures.
  { file: 'x1-ghost-opacity.html', rotations: [], bodyImage: false },
  { file: 'x2-gradient-panel.html', rotations: [], bodyImage: false },
  {
    file: 'x3-rotations.html',
    rotations: [
      { text: 'Tilted card holding a badge', deg: -6 },
      // Inside the −6° card, so the composed angle is what PowerPoint must carry.
      { text: 'NESTED', deg: 14 },
      { text: 'TWENTY EIGHT', deg: 28 },
      { text: 'Rotated about top-left', deg: 10 },
      { text: 'FORTY FIVE', deg: 45 },
      { text: 'SIXTY TWO', deg: 62 },
    ],
    bodyImage: false,
  },
  { file: 'x4-shadows.html', rotations: [], bodyImage: false },
  { file: 'x5-scale-skew-flip.html', rotations: [], bodyImage: false },
  { file: 'x6-vertical-br.html', rotations: [], bodyImage: false },
]

/**
 * One corpus slide as recorded by the Electron harness: the exporter's own measurement pass and
 * the independent ground truth, from the same loaded document. Committed under
 * `tests/fidelity/corpus/recorded/` so the structural targets run in vitest with no app launch.
 * `measurementScriptSha256` pins the recording to the script that produced it — a changed script
 * fails the corpus test closed until the harness is re-run with `--record`.
 */
export type RecordedSlide = {
  file: string
  measurementScriptSha256: string
  measure: MeasureResult
  truth: GroundTruth
}

export function recordedFileName(file: string): string {
  return `${file.replace(/\.html$/, '')}.json`
}
