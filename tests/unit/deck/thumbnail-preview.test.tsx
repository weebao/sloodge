/**
 * @vitest-environment happy-dom
 *
 * The rail's live-frame gate (M8.2): a thumbnail is a document only while its card is inside the
 * scroller's window. Driven through the real `ThumbnailRail`, with the browser's part — reporting
 * what is on screen — played by `FakeIntersectionObserver`.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThumbnailRail } from '../../../src/renderer/src/features/deck/ThumbnailRail'
import { THUMBNAIL_LIVE_MARGIN } from '../../../src/renderer/src/features/deck/ThumbnailPreview'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'
import {
  FakeIntersectionObserver,
  installFakeIntersectionObserver,
} from './fake-intersection-observer'

const slides: SlideView[] = ['One', 'Two', 'Three', 'Four'].map((title, index) => ({
  id: `s_${String(index)}` as SlideId,
  title,
  html: `<!doctype html><html lang="en"><body>${title}</body></html>`,
}))

let revokeObjectUrl = vi.fn<(url: string) => void>()

beforeEach(() => {
  installFakeIntersectionObserver()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  revokeObjectUrl = vi.fn<(url: string) => void>()
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectUrl)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function rail(deck: readonly SlideView[]) {
  return (
    <ThumbnailRail
      slides={deck}
      currentSlideId={deck[0]?.id ?? null}
      onSelectSlide={vi.fn()}
      onAddSlide={vi.fn()}
      onDuplicateSlide={vi.fn()}
      onDeleteSlide={vi.fn()}
      onMoveSlide={vi.fn()}
    />
  )
}

function renderRail(): FakeIntersectionObserver & {
  rerenderWith: (deck: readonly SlideView[]) => void
} {
  const { rerender } = render(rail(slides))
  const observer = FakeIntersectionObserver.instances[0]
  if (observer === undefined) throw new Error('the rail created no observer')
  return Object.assign(observer, {
    rerenderWith: (deck: readonly SlideView[]) => {
      rerender(rail(deck))
    },
  })
}

function frames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll('iframe')]
}

function boxes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-thumbnail]')]
}

describe('thumbnail live gate', () => {
  it('mounts no frame until the observer says a card is on screen', () => {
    renderRail()

    expect(frames()).toEqual([])
    expect(boxes().map((box) => box.dataset['thumbnail'])).toEqual([
      'placeholder',
      'placeholder',
      'placeholder',
      'placeholder',
    ])
    // Every card still has its number and name, so the placeholder is not a blank list.
    expect(screen.getAllByRole('button', { name: /thumbnail/ })).toHaveLength(4)
  })

  it('uses one observer for the whole rail, rooted at the scroller with the pre-warm margin', () => {
    const observer = renderRail()

    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    expect(observer.root).toBe(screen.getByRole('list'))
    expect(observer.rootMargin).toBe(THUMBNAIL_LIVE_MARGIN)
    expect(observer.targets.size).toBe(4)
    // What is observed is the fixed-size box, so mounting a frame cannot move the target.
    expect([...observer.targets]).toEqual(boxes())
  })

  it('mounts a live, inert frame for exactly the cards reported visible', () => {
    const observer = renderRail()
    const [, second, third] = boxes()
    if (second === undefined || third === undefined) throw new Error('boxes')

    observer.report(
      new Map([
        [second, true],
        [third, true],
      ]),
    )

    expect(frames().map((f) => f.getAttribute('title'))).toEqual(['Two', 'Three'])
    for (const frame of frames()) {
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
      expect(frame.style.pointerEvents).toBe('none')
      expect(frame.getAttribute('tabindex')).toBe('-1')
    }
    expect(boxes().map((box) => box.dataset['thumbnail'])).toEqual([
      'placeholder',
      'live',
      'live',
      'placeholder',
    ])
  })

  it('unmounts the frame, releasing its document, when the card scrolls out again', () => {
    const observer = renderRail()
    const [first] = boxes()
    if (first === undefined) throw new Error('boxes')

    observer.report(new Map([[first, true]]))
    expect(frames()).toHaveLength(1)

    observer.report(new Map([[first, false]]))

    expect(frames()).toHaveLength(0)
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
  })

  it('stops observing a card that leaves the deck, and everything on unmount', () => {
    const observer = renderRail()
    expect(observer.targets.size).toBe(4)

    // Delete the last slide: its card unmounts and must unsubscribe itself, or the observer keeps
    // a detached element (and its callback) alive for every slide ever deleted.
    observer.rerenderWith(slides.slice(0, 3))
    expect(observer.targets.size).toBe(3)
    expect([...observer.targets]).toEqual(boxes())

    cleanup()
    expect(observer.targets.size).toBe(0)
  })
})
