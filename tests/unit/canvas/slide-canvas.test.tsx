/**
 * @vitest-environment happy-dom
 *
 * The canvas's Design Mode instrumenter has to have a *stable identity*, and this file is what
 * pins it.
 *
 * `SlideStage` memoizes both the pre-warm gate's document and every mounted frame's on
 * `(documentFor, id, html)`, so the identity of the function the canvas passes is what decides
 * whether a render re-parses. And `SlideCanvas` re-renders constantly: `useElementSize` turns every
 * `ResizeObserver` tick into one, so dragging the panel splitter re-renders it per animation frame.
 * A `documentFor` built inside the render body therefore re-parses, re-addresses and re-injects all
 * three mounted documents ~60 times a second, with nothing visibly wrong — which is why the
 * instrumenter lives at module scope.
 *
 * The stage's own call-count tests (`slide-stage.test.tsx`) inject a stable `documentFor` from a
 * fixture, so they can never observe what the caller hands it. These tests count calls to the real
 * `instrument`, through the real Design Mode path.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlideCanvas } from '../../../src/renderer/src/features/canvas/SlideCanvas'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import { instrument } from '../../../src/shared/design/instrument'
import type * as InstrumentModule from '../../../src/shared/design/instrument'
import type { SlideId } from '../../../src/shared/document/types'

vi.mock('../../../src/shared/design/instrument', async (importOriginal) => {
  const actual = await importOriginal<typeof InstrumentModule>()
  return { ...actual, instrument: vi.fn(actual.instrument) }
})

const instrumentSpy = vi.mocked(instrument)

const slides: SlideView[] = ['A', 'B', 'C'].map((title) => ({
  id: `s_${title}` as SlideId,
  title,
  html: `<!doctype html><html><body><h1>${title}</h1><p>body copy</p></body></html>`,
}))

/** The mat's measured box, read by the stubbed `getBoundingClientRect`. */
let matSize = { width: 1280, height: 720 }

/** Every live `useElementSize` observer, so a test can deliver a resize tick. */
const observers: (() => void)[] = []

class FakeResizeObserver {
  constructor(callback: () => void) {
    observers.push(callback)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function frames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll('iframe')]
}

/** Render, then settle the stage: the active frame loads, the gate opens, the neighbours load. */
function renderSettled(): ReturnType<typeof render> {
  const result = render(<SlideCanvas slides={slides} currentIndex={1} />)
  fireEvent.load(screen.getByTitle('Slide: B'))
  for (const frame of frames()) fireEvent.load(frame)
  return result
}

beforeEach(() => {
  useDesignStore.setState({ enabled: true, hover: null, selection: null, selections: [] })
  matSize = { width: 1280, height: 720 }
  observers.length = 0
  instrumentSpy.mockClear()
  // happy-dom cannot fetch a `blob:` URL; the frames are pointed at about:blank as elsewhere.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
  // happy-dom lays nothing out, so the mat would measure 0x0 and `fitSlide` would return scale 0.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        ...matSize,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  )
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useDesignStore.setState({ enabled: false, hover: null, selection: null, selections: [] })
})

describe('SlideCanvas instruments each document once', () => {
  /**
   * Settling on B costs four parses: the gate and B's own frame each read B (separate memos — the
   * gate has to know the document before any frame exists to report it), then the gate opens and A
   * and C parse once each. This is `slide-stage.test.tsx`'s rule, evaluated through the canvas.
   */
  it('parses the gate’s document plus one per mounted frame, and nothing more per render', () => {
    const { rerender } = renderSettled()
    expect(instrumentSpy).toHaveBeenCalledTimes(4)

    for (let i = 0; i < 3; i += 1) {
      rerender(<SlideCanvas slides={slides} currentIndex={1} />)
    }

    expect(instrumentSpy).toHaveBeenCalledTimes(4)
    // Guards the guard: three renders that really did reach the DOM with the window intact, so a
    // zero delta is a stable instrumenter and not a canvas that stopped rendering.
    expect(frames().map((f) => f.getAttribute('title'))).toEqual([
      'Preloading: A',
      'Slide: B',
      'Preloading: C',
    ])
  })

  it('costs no instrumentation when a resize tick changes only the scale', () => {
    renderSettled()
    expect(instrumentSpy).toHaveBeenCalledTimes(4)
    expect(screen.getByTitle('Slide: B').style.transform).toContain('scale(1)')

    matSize = { width: 640, height: 360 }
    act(() => {
      for (const tick of observers) tick()
    })

    expect(screen.getByTitle('Slide: B').style.transform).toContain('scale(0.5)')
    expect(instrumentSpy).toHaveBeenCalledTimes(4)
  })

  it('instruments nothing with Design Mode off', () => {
    useDesignStore.setState({ enabled: false })

    renderSettled()

    expect(instrumentSpy).not.toHaveBeenCalled()
  })
})
