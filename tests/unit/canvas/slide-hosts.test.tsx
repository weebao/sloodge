/**
 * @vitest-environment happy-dom
 *
 * Which surface publishes on which host (M8.2). The stage — canvas and Present — delivers on the
 * default `slides` host; the rail's miniatures on `thumbnails`, so they land in a renderer process
 * of their own. Observed through the `src` the frames end up with under a fake preload bridge; the
 * host-per-process grouping itself is Chromium's, measured by `pnpm perf:run` / `perf:isolation`.
 *
 * Its own file because `defaultSlideUrls` memoizes the transport per host for the life of the
 * module: the bridge has to exist before the first frame in this module asks for a factory.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlideStage } from '../../../src/renderer/src/features/canvas/SlideStage'
import { ThumbnailRail } from '../../../src/renderer/src/features/deck/ThumbnailRail'
import type { SloodgeBridge } from '../../../src/renderer/src/host/bridge'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'
import {
  SLIDE_STAGE_HOST,
  SLIDE_THUMBNAIL_HOST,
  slideDocumentUrl,
} from '../../../src/shared/slide-protocol'
import {
  FakeIntersectionObserver,
  installFakeIntersectionObserver,
} from '../deck/fake-intersection-observer'

const ID = 'c'.repeat(32)
const slides: SlideView[] = ['One', 'Two'].map((title, index) => ({
  id: `s_${String(index)}` as SlideId,
  title,
  html: `<!doctype html><html lang="en"><body>${title}</body></html>`,
}))

beforeEach(() => {
  // Only the slide half of the bridge is needed for a factory to be the `slide://` one.
  window.sloodge = {
    publishSlide: async () => ID,
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
  it('the stage publishes on the slides host', async () => {
    render(<SlideStage slides={slides} activeIndex={0} scale={1} titlePrefix="Slide" interactive />)
    // The publish round-trip is a resolved promise; let it land.
    await act(async () => {})

    expect(frameSrcs()).toEqual([slideDocumentUrl(ID, SLIDE_STAGE_HOST)])
    expect(new URL(frameSrcs()[0] ?? '').hostname).toBe(SLIDE_STAGE_HOST)
  })

  it('the rail publishes on the thumbnails host', async () => {
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
    for (const src of srcs) {
      expect(src).toBe(slideDocumentUrl(ID, SLIDE_THUMBNAIL_HOST))
      expect(new URL(src).hostname).toBe(SLIDE_THUMBNAIL_HOST)
    }
  })
})
