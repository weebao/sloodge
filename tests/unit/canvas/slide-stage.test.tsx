/**
 * @vitest-environment happy-dom
 *
 * The live window as DOM (M8.2): which frames exist, when the neighbours appear, and that a step to
 * a neighbour promotes an element rather than mounting one. As in `slide-frame.test.tsx`, URLs come
 * from a stub factory (`about:blank#n`) so publish/revoke is observable.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlideStage } from '../../../src/renderer/src/features/canvas/SlideStage'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'

const titles = ['A', 'B', 'C', 'D', 'E']
const slides: SlideView[] = titles.map((title) => ({
  id: `s_${title}` as SlideId,
  title,
  html: `<!doctype html><html><body>${title}</body></html>`,
}))

/** The deck with C moved one slot later: A B D C E. */
const movedDeck: SlideView[] = [slides[0]!, slides[1]!, slides[3]!, slides[2]!, slides[4]!]

/** A stand-in for Design Mode's instrumentation: a marker on the body, same bytes otherwise. */
const documentFor = (_id: SlideId, html: string): string =>
  html.replace('<body>', '<body data-instrumented>')

/**
 * The stage's frames go through `SlideFrame`'s default (blob) transport, and happy-dom cannot fetch
 * a `blob:` URL, so the object-URL API is stubbed to about:blank as in `slide-frame.test.tsx`. The
 * observable here is *which frames exist and which element each one is*, not the URL.
 */
function frames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll('iframe')]
}

function titlesOf(): string[] {
  return frames().map((f) => f.getAttribute('title') ?? '')
}

function stage(activeIndex: number, extra: Partial<Parameters<typeof SlideStage>[0]> = {}) {
  return (
    <SlideStage
      slides={slides}
      activeIndex={activeIndex}
      scale={0.5}
      titlePrefix="Slide"
      interactive
      {...extra}
    />
  )
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SlideStage mounting policy', () => {
  it('mounts only the active slide until its frame has loaded, then its ±1 neighbours', () => {
    render(stage(2))
    expect(titlesOf()).toEqual(['Slide: C'])

    fireEvent.load(screen.getByTitle('Slide: C'))

    expect(titlesOf()).toEqual(['Preloading: B', 'Slide: C', 'Preloading: D'])
  })

  it('renders nothing for an out-of-range index', () => {
    render(stage(-1))
    expect(frames()).toEqual([])
  })

  it('hides the neighbours from sight, input and assistive tech', () => {
    render(stage(2))
    fireEvent.load(screen.getByTitle('Slide: C'))

    const warm = [...document.querySelectorAll<HTMLElement>('[data-slide-role="warm"]')]
    expect(warm).toHaveLength(2)
    for (const wrapper of warm) {
      expect(wrapper.className).toContain('invisible')
      expect(wrapper.hasAttribute('inert')).toBe(true)
      expect(wrapper.getAttribute('aria-hidden')).toBe('true')
      const frame = wrapper.querySelector('iframe')
      expect(frame?.style.pointerEvents).toBe('none')
      expect(frame?.getAttribute('tabindex')).toBe('-1')
    }

    const active = document.querySelector<HTMLElement>('[data-slide-role="active"]')
    expect(active?.hasAttribute('inert')).toBe(false)
    expect(active?.getAttribute('aria-hidden')).toBeNull()
    expect(screen.getByTitle('Slide: C').style.pointerEvents).toBe('auto')
  })

  it('promotes a pre-warmed neighbour in place: same element, no reload, no remount', () => {
    const { rerender } = render(stage(2))
    fireEvent.load(screen.getByTitle('Slide: C'))
    const c = screen.getByTitle('Slide: C')
    const d = screen.getByTitle('Preloading: D')
    fireEvent.load(d)

    rerender(stage(3))

    expect(screen.getByTitle('Slide: D')).toBe(d)
    expect(screen.getByTitle('Preloading: C')).toBe(c)
    // D was already loaded, so E warms immediately and B is gone.
    expect(titlesOf()).toEqual(['Preloading: C', 'Slide: D', 'Preloading: E'])
  })

  it('keeps an already-loaded neighbour mounted across a jump instead of re-mounting it', () => {
    const { rerender } = render(stage(0))
    fireEvent.load(screen.getByTitle('Slide: A'))
    const b = screen.getByTitle('Preloading: B')
    fireEvent.load(b)

    // Jump to C: B is still in the window and already loaded, so it must survive the jump even
    // though C (the new active) has not loaded yet; D is cold and waits.
    rerender(stage(2))

    expect(titlesOf()).toEqual(['Preloading: B', 'Slide: C'])
    expect(screen.getByTitle('Preloading: B')).toBe(b)
  })

  it('treats a slide that left the window as cold when it comes back', () => {
    const { rerender } = render(stage(2))
    fireEvent.load(screen.getByTitle('Slide: C'))
    for (const frame of frames()) fireEvent.load(frame)

    // Away to the end of the deck: B and C unmount.
    rerender(stage(4))
    expect(titlesOf()).toEqual(['Preloading: D', 'Slide: E'])

    // Back to C: D is still loaded and stays; B left the window, so it is cold again and waits
    // for C — a stale "loaded" mark would mount it here and contend with the active slide.
    rerender(stage(2))
    expect(titlesOf()).toEqual(['Slide: C', 'Preloading: D'])
  })

  it('points frameRef at the active frame and follows the selection', () => {
    const frameRef = createRef<HTMLIFrameElement>()
    const { rerender } = render(stage(2, { frameRef }))
    expect(frameRef.current).toBe(screen.getByTitle('Slide: C'))

    fireEvent.load(screen.getByTitle('Slide: C'))
    fireEvent.load(screen.getByTitle('Preloading: D'))
    rerender(stage(3, { frameRef }))

    expect(frameRef.current).toBe(screen.getByTitle('Slide: D'))
  })

  it('gives the Design Mode document to every mounted frame, not just the active one', async () => {
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((source) => {
      blobs.push(source as Blob)
      return `about:blank#${String(blobs.length - 1)}`
    })
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)

    render(stage(2, { documentFor }))
    fireEvent.load(screen.getByTitle('Slide: C'))

    const documents = await Promise.all(blobs.map(async (blob) => blob.text()))
    expect(documents).toHaveLength(3)
    for (const doc of documents) expect(doc).toContain('data-instrumented')
    expect(documents.filter((doc) => doc.includes('>C<'))).toHaveLength(1)
  })

  /**
   * The load-count semantics of a step (M8.2 round 1). Every frame in the window shows the same
   * kind of document, so promoting a neighbour swaps nothing: one step is exactly one URL mint — the
   * cold neighbour entering the window — and no surviving frame's `src` changes. This is the same
   * number with Design Mode off; round 0 instrumented the active frame only, and a step then
   * re-minted both the incoming and the outgoing frame (three mints, two reloads).
   */
  it.each([
    ['off', undefined],
    ['on', documentFor],
  ])('with Design Mode %s, a step mints one URL and changes no surviving frame', (_label, docs) => {
    let mints = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      mints += 1
      return `about:blank#${String(mints)}`
    })
    const { rerender } = render(stage(2, { documentFor: docs }))
    fireEvent.load(screen.getByTitle('Slide: C'))
    for (const frame of frames()) fireEvent.load(frame)
    expect(mints).toBe(3)
    const c = screen.getByTitle('Slide: C')
    const d = screen.getByTitle('Preloading: D')
    const [cSrc, dSrc] = [c.getAttribute('src'), d.getAttribute('src')]

    rerender(stage(3, { documentFor: docs }))

    expect(mints).toBe(4)
    expect(screen.getByTitle('Slide: D').getAttribute('src')).toBe(dSrc)
    expect(screen.getByTitle('Preloading: C').getAttribute('src')).toBe(cSrc)
    expect(titlesOf()).toEqual(['Preloading: C', 'Slide: D', 'Preloading: E'])
  })

  it('toggling Design Mode re-mints every mounted frame, once', () => {
    let mints = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      mints += 1
      return `about:blank#${String(mints)}`
    })
    const { rerender } = render(stage(2))
    fireEvent.load(screen.getByTitle('Slide: C'))
    for (const frame of frames()) fireEvent.load(frame)
    expect(mints).toBe(3)

    rerender(stage(2, { documentFor }))
    expect(mints).toBe(6)
    rerender(stage(2, { documentFor }))
    expect(mints).toBe(6)
  })

  /**
   * Frames are ordered by id, never by deck position (`liveSlideWindow`). Moving the selected slide
   * one slot changes the deck-ordered window from [B, C, D] to [D, C, E]; if the DOM followed deck
   * order React would move C's wrapper, and a re-inserted iframe reloads its document. The visible
   * slide must stay exactly where it is, and its element must be the same one.
   */
  it('moving the active slide in the deck moves no frame in the DOM', () => {
    const { rerender } = render(stage(2))
    fireEvent.load(screen.getByTitle('Slide: C'))
    for (const frame of frames()) fireEvent.load(frame)
    const c = screen.getByTitle('Slide: C')
    const d = screen.getByTitle('Preloading: D')
    const before = frames()

    // A B C D E → A B D C E, C still selected (now index 3): the window is D, C, E.
    rerender(
      <SlideStage slides={movedDeck} activeIndex={3} scale={0.5} titlePrefix="Slide" interactive />,
    )

    expect(screen.getByTitle('Slide: C')).toBe(c)
    expect(screen.getByTitle('Preloading: D')).toBe(d)
    const survivors = (list: HTMLIFrameElement[]) => list.filter((f) => f === c || f === d)
    expect(survivors(frames())).toEqual(survivors(before))
    expect(titlesOf()).toEqual(['Slide: C', 'Preloading: D', 'Preloading: E'])
  })
})
