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

  it('gives the Design Mode document to the active frame only', async () => {
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((source) => {
      blobs.push(source as Blob)
      return `about:blank#${String(blobs.length - 1)}`
    })
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)

    render(stage(2, { activeHtml: '<!doctype html><html><body>instrumented</body></html>' }))
    fireEvent.load(screen.getByTitle('Slide: C'))

    const documents = await Promise.all(blobs.map(async (blob) => blob.text()))
    const instrumented = documents.filter((doc) => doc.includes('instrumented'))
    expect(instrumented).toHaveLength(1)
    expect(documents).toHaveLength(3)
    // The active frame got it; the neighbours got their stored source.
    expect(screen.getByTitle('Slide: C').getAttribute('src')).toBe('about:blank#0')
    expect(documents[0]).toContain('instrumented')
    expect(documents[1]).toContain('>B<')
    expect(documents[2]).toContain('>D<')
  })
})
