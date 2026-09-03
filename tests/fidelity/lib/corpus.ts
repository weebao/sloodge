/**
 * The 8-slide fixture corpus from research/pptx-export-fidelity.md §0, with the load-bearing
 * constructs each slide is *declared* to carry. Text nodes are not declared here — the ground-truth
 * script (`truth.ts`) discovers them — but rotations and a painted body background are, because
 * "did the exporter keep it" is only checkable against a statement of what was there.
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
