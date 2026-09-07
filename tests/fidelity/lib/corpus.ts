/**
 * The fixture corpus, with the load-bearing constructs each slide is *declared* to carry. Text nodes,
 * painted boxes and pseudo-elements are not declared here — the ground-truth script (`truth.ts`)
 * discovers them — but rotations and a painted body background are, because "did the exporter keep
 * it" is only checkable against a statement of what was there.
 *
 * Slides `01`–`08` are research/pptx-export-fidelity.md §0. Slides `x1`–`x21` were written *against*
 * the finished exporter, not alongside it: each one reproduced a construct that scored 85–100 while
 * vanishing from — or arriving wrong in — the `.pptx`. `x1`–`x6` came from review r1, `x7`–`x9` from
 * r2's probe set, `x10` reproduces the standalone `rotate:`/`scale:` properties, `x11`–`x16` are
 * r3's, `x17`/`x18` are r4's paint-order pair, `x19`/`x20` are M4.8b's run-level text pair, and
 * `x21` is its review-r2 probe of the line-spacing oracle. They are in the corpus so the next tuning
 * pass cannot quietly fit the scorer to the eight slides it was born with.
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
  // Out-of-corpus probes from review r2, promoted the same way.
  { file: 'x7-masked-panel.html', rotations: [], bodyImage: false },
  { file: 'x8-hollow-type.html', rotations: [], bodyImage: false },
  { file: 'x9-clipped-text.html', rotations: [], bodyImage: false },
  {
    file: 'x10-rotate-property.html',
    // Authored with the standalone `rotate:` property, which does not fold into the computed
    // `transform` — the element shipped upright at rot=0 until r2 (research §1.3(b)).
    rotations: [{ text: 'ROTATED 20', deg: 20 }],
    bodyImage: false,
  },
  // Review r3's probes. The first two are the ones the census mechanism could not see at all: the
  // root elements are outside `body.querySelectorAll('*')`, and the probe baseline was reachable by
  // author `!important`. The last three name a `LAYOUT_RESOLVED_PROPERTIES` entry whose written
  // justification was false — including two that made the exporter INVENT content.
  { file: 'x11-body-filter.html', rotations: [], bodyImage: false },
  { file: 'x12-important-mask.html', rotations: [], bodyImage: false },
  { file: 'x13-contain-paint.html', rotations: [], bodyImage: false },
  { file: 'x14-visibility-collapse.html', rotations: [], bodyImage: false },
  { file: 'x15-content-url.html', rotations: [], bodyImage: false },
  { file: 'x16-gradient-hero.html', rotations: [], bodyImage: false },
  // Review r4's probe, and the only PAIR here: two files differing in exactly one declaration
  // (asserted), which reverses paint order while leaving every rect, colour and emitted shape
  // identical. Neither slide shows anything alone — x17 is the control that must stay clean.
  { file: 'x17-paint-order.html', rotations: [], bodyImage: false },
  { file: 'x18-view-transition-name.html', rotations: [], bodyImage: false },
  // M4.8b's pair. x19 is every run-level construct in one deck — bare text beside inline elements,
  // mixed sizes on one line, a `<br>` inside a bullet, `capitalize`, `pre`, propagated underline,
  // an inline highlight, non-breaking spaces — and must ship as structured text with nothing lost.
  // x20 is the flow PowerPoint cannot reproduce (an inline-block pill mid-sentence, text on both
  // sides of a nested block) and must be named, never shipped at high confidence.
  { file: 'x19-inline-runs.html', rotations: [], bodyImage: false },
  { file: 'x20-inline-flow.html', rotations: [], bodyImage: false },
  // r2's probe: two text blocks at one rect (an `inset: 0` overlay) with different line-heights.
  // Exports correctly; the oracle's line-spacing pairing reported it as a silent lie.
  { file: 'x21-overlay-spacing.html', rotations: [], bodyImage: false },
]

/**
 * One corpus slide as recorded by the Electron harness: the exporter's own measurement pass and
 * the independent ground truth, from the same loaded document. Committed under
 * `tests/fidelity/corpus/recorded/` so the structural targets run in vitest with no app launch.
 * Both halves are pinned to the script that produced them — `measurementScriptSha256` for the
 * exporter's pass, `groundTruthScriptSha256` for the oracle — so changing either fails the corpus
 * test closed until the harness is re-run with `--record`. The oracle is pinned for the same reason
 * as the pass it judges, and against a mistake that has already happened once (r5).
 */
export type RecordedSlide = {
  file: string
  measurementScriptSha256: string
  groundTruthScriptSha256: string
  measure: MeasureResult
  truth: GroundTruth
}

export function recordedFileName(file: string): string {
  return `${file.replace(/\.html$/, '')}.json`
}
