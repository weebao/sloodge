import { describe, expect, it, vi } from 'vitest'
import { buildSlidesPptx } from '../../../src/main/export/pptx-export'
import { writeDeckPptx } from '../../../src/main/export/pptx-writer'
import type { PptxSlideRender, SlidePptxRenderer } from '../../../src/main/export/pptx-renderer'
import type { DeckPptxPlan } from '../../../src/shared/export/pptx/types'
import type { SlideExportInput } from '../../../src/shared/export/types'
import { makeMeasure, makeNode } from './pptx/_fixtures'

const PNG = 'data:image/png;base64,AAAA'

/** A renderer that returns a plain-text measure per slide, and can be told to throw for one. */
function fakeRenderer(options: { throwOn?: number } = {}): SlidePptxRenderer {
  return {
    renderSlide: vi.fn((html: string, index: number): Promise<PptxSlideRender> => {
      if (options.throwOn === index) return Promise.reject(new Error('render boom'))
      const measure = makeMeasure([makeNode({ tag: 'h1', isLeaf: true, text: html })])
      return Promise.resolve({ measure, rasterDataUrl: PNG })
    }),
    dispose: vi.fn(),
  }
}

/** A writer that records the plan it was handed and returns a real, unzippable `.pptx`. */
function recordingWriter(): {
  write: (plan: DeckPptxPlan) => Promise<Uint8Array>
  plans: DeckPptxPlan[]
} {
  const plans: DeckPptxPlan[] = []
  return {
    plans,
    write: (plan) => {
      plans.push(plan)
      return writeDeckPptx(plan)
    },
  }
}

const slides: SlideExportInput[] = [
  { title: 'A', html: 'A' },
  { title: 'B', html: 'B' },
  { title: 'C', html: 'C' },
]

const base = {
  currentIndex: 0,
  outPath: '/out/deck.pptx',
  deckTitle: 'Deck',
  fidelity: 'auto' as const,
}

describe('buildSlidesPptx', () => {
  it('renders the whole range in order and reads the slide count back from the file', async () => {
    const writer = recordingWriter()
    const result = await buildSlidesPptx({
      ...base,
      slides,
      range: { kind: 'all' },
      renderer: fakeRenderer(),
      writer,
    })
    expect(result.pptxBytes).not.toBeNull()
    expect(result.report.slideCount).toBe(3)
    expect(result.report.emittedSlideCount).toBe(3)
    expect(result.report.slides.map((s) => s.title)).toEqual(['A', 'B', 'C'])
    expect(result.report.slides.every((s) => s.status === 'ok')).toBe(true)
    expect(writer.plans[0]!.slides).toHaveLength(3)
  })

  it('respects a sub-range', async () => {
    const writer = recordingWriter()
    const result = await buildSlidesPptx({
      ...base,
      slides,
      range: { kind: 'range', from: 2, to: 3 },
      renderer: fakeRenderer(),
      writer,
    })
    expect(result.report.slides.map((s) => s.title)).toEqual(['B', 'C'])
    expect(result.report.emittedSlideCount).toBe(2)
  })

  it('isolates a failed slide: it is reported but the rest still export', async () => {
    const writer = recordingWriter()
    const result = await buildSlidesPptx({
      ...base,
      slides,
      range: { kind: 'all' },
      renderer: fakeRenderer({ throwOn: 1 }),
      writer,
    })
    expect(result.report.slides[1]).toMatchObject({ title: 'B', status: 'failed' })
    expect(result.report.emittedSlideCount).toBe(2)
    expect(result.pptxBytes).not.toBeNull()
  })

  it('writes nothing for an empty range and for an all-failed deck', async () => {
    const empty = await buildSlidesPptx({
      ...base,
      slides,
      range: { kind: 'range', from: 50, to: 60 },
      renderer: fakeRenderer(),
      writer: recordingWriter(),
    })
    expect(empty.pptxBytes).toBeNull()
    expect(empty.report.slideCount).toBe(0)

    const allFail = await buildSlidesPptx({
      ...base,
      slides: [{ title: 'X', html: 'X' }],
      range: { kind: 'all' },
      renderer: fakeRenderer({ throwOn: 0 }),
      writer: recordingWriter(),
    })
    expect(allFail.pptxBytes).toBeNull()
    expect(allFail.report.slides[0]!.status).toBe('failed')
  })

  it('passes the fidelity through: force-raster makes every slide a raster tier', async () => {
    const writer = recordingWriter()
    await buildSlidesPptx({
      ...base,
      fidelity: 'raster',
      slides,
      range: { kind: 'all' },
      renderer: fakeRenderer(),
      writer,
    })
    expect(writer.plans[0]!.slides.every((s) => s.tier === 'raster')).toBe(true)
  })

  it('reports progress per slide and at assembly', async () => {
    const onProgress = vi.fn()
    await buildSlidesPptx({
      ...base,
      slides,
      range: { kind: 'all' },
      renderer: fakeRenderer(),
      writer: recordingWriter(),
      onProgress,
    })
    const phases = onProgress.mock.calls.map((c) => (c[0] as { phase: string }).phase)
    expect(phases).toContain('rendering')
    expect(phases).toContain('assembling')
  })
})
