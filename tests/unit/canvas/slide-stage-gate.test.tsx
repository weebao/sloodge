/**
 * @vitest-environment happy-dom
 *
 * The pre-warm gate is keyed by *document*, not by slide id (M8.2 round 1). On the `slide://` path a
 * frame keeps its old `src` until the new URL has been published, and a `load` that fires in that
 * window — the old document's in-flight load, or the 404 its revoked URL now answers with — is not
 * the load the stage is waiting for. A gate keyed by id would open on it and mount the cold
 * neighbours while the active slide's real document is still being published and parsed, which is
 * the contention the gate exists to prevent.
 *
 * Own file because `defaultSlideUrls` memoizes the transport per surface for the life of the module,
 * so the deferred bridge has to be installed before any frame asks for a factory.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SlideStage } from '../../../src/renderer/src/features/canvas/SlideStage'
import type { SloodgeBridge } from '../../../src/renderer/src/host/bridge'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'

const slides: SlideView[] = ['A', 'B', 'C', 'D', 'E'].map((title) => ({
  id: `s_${title}` as SlideId,
  title,
  html: `<!doctype html><html><body>${title}</body></html>`,
}))

const documentFor = (_id: SlideId, html: string): string =>
  html.replace('<body>', '<body data-instrumented>')

/** Publishes resolve only when the test says so, one fresh id each. */
let pending: ((id: string) => void)[] = []

beforeEach(() => {
  pending = []
  window.sloodge = {
    publishSlide: async () =>
      new Promise<string>((resolve) => {
        pending.push(resolve)
      }),
    revokeSlide: async () => true,
  } as unknown as SloodgeBridge
})

afterEach(() => {
  cleanup()
  delete window.sloodge
})

async function settle(index: number): Promise<void> {
  await act(async () => {
    pending[index]?.((index + 1).toString(16).padStart(32, '0'))
  })
}

/**
 * Which frames the stage has mounted, by role, in id order. Wrappers rather than iframes: on the
 * `slide://` path a frame renders no `<iframe>` until its publish resolves, so a neighbour that has
 * just been mounted is a wrapper with an empty box.
 */
function rolesOf(): string[] {
  return [...document.querySelectorAll('[data-slide-role]')].map(
    (el) => el.getAttribute('data-slide-role') ?? '',
  )
}

describe('SlideStage pre-warm gate is keyed by document', () => {
  it('ignores a load for the document the frame was showing before its html changed', async () => {
    const { rerender } = render(
      <SlideStage slides={slides} activeIndex={2} scale={0.5} titlePrefix="Slide" interactive />,
    )
    await settle(0)
    const c = screen.getByTitle('Slide: C')
    const rawSrc = c.getAttribute('src')
    expect(rawSrc).not.toBeNull()

    // Design Mode turns on before the raw document has loaded: C's html changes, the new document
    // is publishing, and the iframe still points at the raw one.
    rerender(
      <SlideStage
        slides={slides}
        activeIndex={2}
        documentFor={documentFor}
        scale={0.5}
        titlePrefix="Slide"
        interactive
      />,
    )
    expect(c.getAttribute('src')).toBe(rawSrc)

    // The raw document's load arrives. It is not the instrumented document; the gate stays shut.
    fireEvent.load(c)
    expect(rolesOf()).toEqual(['active'])

    // The instrumented document is published and loads; now the neighbours may warm.
    await settle(1)
    expect(c.getAttribute('src')).not.toBe(rawSrc)
    fireEvent.load(c)
    expect(rolesOf()).toEqual(['warm', 'active', 'warm'])
  })
})
