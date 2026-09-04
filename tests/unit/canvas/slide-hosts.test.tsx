/**
 * @vitest-environment happy-dom
 *
 * Which surface publishes on which host (M8.2). The stage — canvas and Present — delivers every
 * document on a host of its own (`stage-<id>`), so a hung neighbour cannot stall the active slide;
 * the rail's miniatures all publish on `thumbnails`, so the rail is one renderer process. Observed
 * through the `src` the frames end up with under a fake preload bridge; the host-per-process
 * grouping itself is Chromium's, measured by `pnpm perf:run` / `perf:isolation`.
 *
 * Its own file because `defaultSlideUrls` memoizes the transport per surface for the life of the
 * module: the bridge has to exist before the first frame in this module asks for a factory.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlideStage } from '../../../src/renderer/src/features/canvas/SlideStage'
import { ThumbnailRail } from '../../../src/renderer/src/features/deck/ThumbnailRail'
import type { SloodgeBridge } from '../../../src/renderer/src/host/bridge'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'
import {
  SLIDE_THUMBNAIL_HOST,
  slideDocumentHost,
  slideDocumentIdFromUrl,
} from '../../../src/shared/slide-protocol'
import {
  FakeIntersectionObserver,
  installFakeIntersectionObserver,
} from '../deck/fake-intersection-observer'

const slides: SlideView[] = ['One', 'Two'].map((title, index) => ({
  id: `s_${String(index)}` as SlideId,
  title,
  html: `<!doctype html><html lang="en"><body>${title}</body></html>`,
}))

/** A fresh, well-formed id per publish, the way main hands them out. */
let published = 0

beforeEach(() => {
  published = 0
  // Only the slide half of the bridge is needed for a factory to be the `slide://` one.
  window.sloodge = {
    publishSlide: async () => {
      published += 1
      return published.toString(16).padStart(32, '0')
    },
    revokeSlide: async () => true,
  } as unknown as SloodgeBridge
  installFakeIntersectionObserver()
})

afterEach(() => {
  cleanup()
  delete window.sloodge
  vi.unstubAllGlobals()
})

function frameSrcs(): string[] {
  return [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src') ?? '')
}

describe('slide document hosts by surface', () => {
  it('the stage publishes every document on its own stage host', async () => {
    render(<SlideStage slides={slides} activeIndex={0} scale={1} titlePrefix="Slide" interactive />)
    // The publish round-trip is a resolved promise; let it land, then let the neighbour warm.
    await act(async () => {})
    fireEvent.load(screen.getByTitle('Slide: One'))
    await act(async () => {})

    const srcs = frameSrcs()
    expect(srcs).toHaveLength(2)
    const hosts = srcs.map((src) => new URL(src).hostname)
    expect(new Set(hosts).size).toBe(2)
    for (const src of srcs) {
      expect(new URL(src).hostname).toBe(
        slideDocumentHost(slideDocumentIdFromUrl(src) ?? '', 'stage'),
      )
    }
  })

  it('the rail publishes every miniature on the one thumbnails host', async () => {
    render(
      <ThumbnailRail
        slides={slides}
        currentSlideId={slides[0]?.id ?? null}
        onSelectSlide={vi.fn()}
        onAddSlide={vi.fn()}
        onDuplicateSlide={vi.fn()}
        onDeleteSlide={vi.fn()}
        onMoveSlide={vi.fn()}
      />,
    )
    FakeIntersectionObserver.instances[0]?.reportAll(true)
    await act(async () => {})

    const srcs = frameSrcs()
    expect(srcs).toHaveLength(2)
    expect(new Set(srcs).size).toBe(2)
    for (const src of srcs) expect(new URL(src).hostname).toBe(SLIDE_THUMBNAIL_HOST)
  })
})
