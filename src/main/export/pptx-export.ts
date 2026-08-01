/**
 * The PPTX export orchestrator (M4.3) — the decision half, kept free of `electron` so its properties
 * are unit-testable with a fake renderer and a fake writer. It mirrors `buildSlidesPdf` deliberately:
 *
 *  - **range selection** via `resolveRange` (reused verbatim);
 *  - **order preserved**: slide k of the deck is slide k of the range;
 *  - **error isolation**: a slide whose render/plan throws is collected and reported, and the deck of
 *    the rest is still produced (60-export.md §6.3);
 *  - **per-slide tier**: each slide is measured, scored, and planned (`planSlide`), so the
 *    structured-vs-raster choice is honest and recorded;
 *  - **proof, not claim**: the written `.pptx` is unzipped and its `ppt/slides/slideN.xml` parts
 *    counted, so `emittedSlideCount` is read back from the real file.
 *
 * The two things it cannot do itself — render/measure/capture a slide, and turn a plan into `.pptx`
 * bytes — are the injected `SlidePptxRenderer` and `PptxWriter` seams. In production those are the
 * offscreen `BrowserWindow` (`pptx-renderer.ts`) and pptxgenjs (`pptx-writer.ts`); in tests they are
 * fakes, over which the real planner and OPC read-back run.
 */

import { resolveRange } from '../../shared/export/range'
import { planSlide } from '../../shared/export/pptx/plan'
import { pptxSlideCount } from './pptx-opc'
import type { SlideExportInput, SlideRange } from '../../shared/export/types'
import type {
  DeckPptxPlan,
  ExportPptxRequest,
  PptxExportReport,
  PptxSlideOutcome,
  SlidePlan,
} from '../../shared/export/pptx/types'
import type { SlidePptxRenderer } from './pptx-renderer'
import type { PptxWriter } from './pptx-writer'

export type PptxExportProgress = {
  phase: 'rendering' | 'assembling'
  /** 1-based, for display. `0` during `assembling`. */
  slideIndex: number
  total: number
  slideTitle: string
}

export type BuildPptxArgs = {
  slides: readonly SlideExportInput[]
  range: SlideRange
  currentIndex: number
  fidelity: ExportPptxRequest['fidelity']
  outPath: string
  deckTitle: string
  renderer: SlidePptxRenderer
  writer: PptxWriter
  onProgress?: (progress: PptxExportProgress) => void
}

export type BuildPptxResult = {
  /** `null` when the range was empty or every slide failed — nothing to write. */
  pptxBytes: Uint8Array | null
  report: PptxExportReport
}

const AUTHOR = 'Sloodge'

/** Human-readable notes for one slide's report row: its top reasons, capped so the row stays legible. */
function outcomeNotes(plan: SlidePlan): string[] {
  return plan.reasons.slice(0, 4)
}

/**
 * Render the resolved range sequentially, plan each slide, then emit one `.pptx`. Sequential by
 * construction (never `Promise.all`): parallel hidden windows contend for the GPU process and make the
 * animation "final frame" capture nondeterministic (60-export.md §1.4). Always resolves — a failed
 * slide is a report entry, never a rejection — except that a writer that throws propagates, because a
 * corrupt package is a pipeline defect the user cannot act on and must not be written as a truncated
 * file.
 */
export async function buildSlidesPptx(args: BuildPptxArgs): Promise<BuildPptxResult> {
  const {
    slides,
    range,
    currentIndex,
    fidelity,
    outPath,
    deckTitle,
    renderer,
    writer,
    onProgress,
  } = args

  const indices = resolveRange(range, slides.length, currentIndex)
  const outcomes: PptxSlideOutcome[] = []
  const warnings: string[] = []
  const plans: SlidePlan[] = []

  if (indices.length === 0) {
    warnings.push('The selected range contains no slides.')
    return {
      pptxBytes: null,
      report: {
        format: 'pptx',
        outPath,
        slideCount: 0,
        emittedSlideCount: 0,
        slides: [],
        warnings,
      },
    }
  }

  for (const [position, slideIndex] of indices.entries()) {
    const slide = slides[slideIndex]
    if (slide === undefined) continue
    onProgress?.({
      phase: 'rendering',
      slideIndex: position + 1,
      total: indices.length,
      slideTitle: slide.title,
    })

    try {
      // Sequential on purpose (see the function docstring): one window, one render at a time.
      // oxlint-disable-next-line no-await-in-loop
      const rendered = await renderer.renderSlide(slide.html, position)
      const plan = planSlide({
        measure: rendered.measure,
        fidelity,
        rasterDataUrl: rendered.rasterDataUrl,
      })
      plans.push(plan)
      outcomes.push({
        index: position,
        title: slide.title,
        status: 'ok',
        tier: plan.tier,
        confidence: plan.confidence,
        notes: outcomeNotes(plan),
      })
      // Branch on the planner's machine-readable discriminant, never on the wording of a `reasons`
      // entry: a prose match here meant rewording a string in `plan.ts` silently deleted this
      // user-facing warning with every test still green (review round 5).
      if (plan.downgrade?.kind === 'capture-failed') {
        warnings.push(
          `Slide ${String(position + 1)} (${slide.title}) had no raster capture and kept structured shapes.`,
        )
      }
    } catch (error) {
      outcomes.push({
        index: position,
        title: slide.title,
        status: 'failed',
        notes: [],
        error: error instanceof Error ? error.message : String(error),
      })
      warnings.push(`Slide ${String(position + 1)} (${slide.title}) could not be exported.`)
    }
  }

  if (plans.length === 0) {
    warnings.push('No slides could be exported.')
    return {
      pptxBytes: null,
      report: {
        format: 'pptx',
        outPath,
        slideCount: indices.length,
        emittedSlideCount: 0,
        slides: outcomes,
        warnings,
      },
    }
  }

  onProgress?.({ phase: 'assembling', slideIndex: 0, total: indices.length, slideTitle: '' })
  const deckPlan: DeckPptxPlan = { title: deckTitle, author: AUTHOR, slides: plans }
  const pptxBytes = await writer.write(deckPlan)
  const emittedSlideCount = pptxSlideCount(pptxBytes)

  if (emittedSlideCount !== plans.length) {
    warnings.push(
      `Expected ${String(plans.length)} slides in the .pptx but found ${String(emittedSlideCount)}.`,
    )
  }

  return {
    pptxBytes,
    report: {
      format: 'pptx',
      outPath,
      slideCount: indices.length,
      emittedSlideCount,
      slides: outcomes,
      warnings,
    },
  }
}
