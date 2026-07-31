/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlideFrame, SLIDE_SANDBOX } from '../../../src/renderer/src/features/canvas/SlideFrame'
import type { SlideUrlFactory } from '../../../src/renderer/src/features/canvas/useSlideUrl'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'

/**
 * happy-dom implements `URL.createObjectURL` but has no blob store behind it: an iframe pointed at
 * a `blob:` URL tries to *fetch* it and throws `URL scheme "blob" is not supported`. So every URL
 * in this file is an `about:blank`, which happy-dom navigates happily — distinguished by a
 * fragment (`about:blank#0`, `#1`) where a test needs to tell one document from the next.
 *
 * That is a limitation of the test host, not a gap in coverage: what the frame does with the URL
 * it is given is pinned here, the create/revoke lifecycle is pinned in `use-slide-url.test.tsx`,
 * and which transport a given host selects is pinned in `slide-url-factory.test.tsx`. What no test
 * here can show is the browser behaviour the whole design is *for* — that a `slide://` document
 * does not inherit the host CSP and a `blob:` one does. That needs a real Chromium in a real
 * Electron, which is `experiments/init/harness/slide-protocol-smoke.mjs`.
 */
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SLIDE_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'
const HTML = createStarterSlideHtml({ id: SLIDE_ID, title: 'First' })
const OTHER_HTML = createStarterSlideHtml({ id: SLIDE_ID, title: 'Second' })

/** Records the documents handed to the object-URL API; see `use-slide-url.test.tsx`. */
function stubUrls(): SlideUrlFactory & { created: string[]; revoked: string[] } {
  const created: string[] = []
  const revoked: string[] = []
  return {
    created,
    revoked,
    create: (html) => {
      created.push(html)
      return `about:blank#${String(created.length - 1)}`
    },
    revoke: (url) => {
      revoked.push(url)
    },
  }
}

function frame(): HTMLIFrameElement {
  return screen.getByTitle('slide') as HTMLIFrameElement
}

describe('SlideFrame sandbox invariants', () => {
  // §7 of 10-architecture.md specifies URL delivery *rather than* srcdoc, and M2.0 makes that URL
  // a `slide://` one under Electron. Either way the document arrives as a real navigation with a
  // real document URL, never HTML-escaped into an attribute.
  it('renders the slide through a url, not srcdoc', () => {
    const urls = stubUrls()
    render(<SlideFrame html={HTML} title="slide" scale={0.5} slideUrls={urls} />)

    expect(frame().getAttribute('src')).toBe('about:blank#0')
    expect(frame().getAttribute('srcdoc')).toBeNull()

    const wrapped = urls.created[0] ?? ''
    expect(wrapped).toContain('data-sl-slide="s_01H8XQZ4P7K2M9NB3VYRTC6FDA"')
    expect(wrapped).toContain('>First<')
    // The CSP wrapper (sandbox layer 3) is applied on the way in.
    expect(wrapped).toContain('http-equiv="Content-Security-Policy"')
  })

  // The whole security model. `allow-same-origin` next to `allow-scripts` lets the framed
  // document reach `window.parent`, read the app DOM and even remove its own sandbox attribute —
  // it is equivalent to no sandbox at all.
  it('sandboxes with exactly allow-scripts and nothing else', () => {
    render(<SlideFrame html={HTML} title="slide" scale={1} />)

    expect(frame().getAttribute('sandbox')).toBe('allow-scripts')
    expect(SLIDE_SANDBOX).toBe('allow-scripts')
    for (const token of [
      'allow-same-origin',
      'allow-top-navigation',
      'allow-popups',
      'allow-modals',
      'allow-forms',
    ]) {
      expect(frame().getAttribute('sandbox')).not.toContain(token)
    }
  })

  it('leaks no referrer and grants no permissions', () => {
    render(<SlideFrame html={HTML} title="slide" scale={1} />)

    expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame().getAttribute('allow')).toBe('')
  })
})

describe('SlideFrame scaling', () => {
  it('keeps the frame at its intrinsic 1280x720 and scales it with a transform', () => {
    render(<SlideFrame html={HTML} title="slide" scale={0.25} />)

    expect(frame().style.width).toBe('1280px')
    expect(frame().style.height).toBe('720px')
    expect(frame().style.transform).toBe('scale(0.25)')
    expect(frame().style.transformOrigin).toBe('top left')
  })

  it('sizes the wrapper to the painted (letterboxed) box', () => {
    const { container } = render(<SlideFrame html={HTML} title="slide" scale={0.5} />)

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.style.width).toBe('640px')
    expect(wrapper.style.height).toBe('360px')
    expect(wrapper.style.overflow).toBe('hidden')
  })

  // `scale` is a public prop and the JSDoc promises a non-positive scale paints an empty box.
  // NaN would break that promise the worst way: `scale(NaN)` and `NaNpx` are invalid declarations
  // that CSS drops, leaving an unscaled 1280px frame bursting out of the rail.
  it.each([
    ['negative', -2],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('clamps a %s scale to an empty box', (_label, scale) => {
    const { container } = render(<SlideFrame html={HTML} title="slide" scale={scale} />)

    expect((container.firstElementChild as HTMLElement).style.width).toBe('0px')
    expect((container.firstElementChild as HTMLElement).style.height).toBe('0px')
    expect(frame().style.transform).toBe('scale(0)')
  })

  it('is inert and out of the tab order when not interactive', () => {
    render(<SlideFrame html={HTML} title="slide" scale={0.1} interactive={false} />)

    expect(frame().style.pointerEvents).toBe('none')
    expect(frame().getAttribute('tabindex')).toBe('-1')
    expect(frame().getAttribute('aria-hidden')).toBe('true')
  })

  it('takes pointer input when interactive', () => {
    render(<SlideFrame html={HTML} title="slide" scale={1} />)

    expect(frame().style.pointerEvents).toBe('auto')
    expect(frame().getAttribute('tabindex')).toBeNull()
    expect(frame().getAttribute('aria-hidden')).toBeNull()
  })
})

describe('SlideFrame document stability', () => {
  // A new `src` reloads the document: animations restart from frame zero and any interactive state
  // is lost. A window resize must therefore not touch it — only the transform.
  it('does not reload the document when only the scale changes', () => {
    const urls = stubUrls()
    const { rerender } = render(
      <SlideFrame html={HTML} title="slide" scale={0.25} slideUrls={urls} />,
    )
    const before = frame()

    rerender(<SlideFrame html={HTML} title="slide" scale={0.75} slideUrls={urls} />)

    // Same DOM node (no remount), same url (no reload), and no second document was ever minted.
    expect(frame()).toBe(before)
    expect(frame().getAttribute('src')).toBe('about:blank#0')
    expect(urls.created).toHaveLength(1)
    expect(urls.revoked).toEqual([])
    expect(frame().style.transform).toBe('scale(0.75)')
  })

  it('reloads, and revokes the old url, when the html changes', () => {
    const urls = stubUrls()
    const { rerender } = render(<SlideFrame html={HTML} title="slide" scale={1} slideUrls={urls} />)
    const before = frame()

    rerender(<SlideFrame html={OTHER_HTML} title="slide" scale={1} slideUrls={urls} />)

    expect(frame().getAttribute('src')).toBe('about:blank#1')
    expect(urls.created[1]).toContain('>Second<')
    // The old document is released rather than leaked for the life of the window.
    expect(urls.revoked).toEqual(['about:blank#0'])
    // Updated in place: React swaps the attribute, so the element identity survives.
    expect(frame()).toBe(before)
  })

  it('revokes its url on unmount', () => {
    const urls = stubUrls()
    const { unmount } = render(<SlideFrame html={HTML} title="slide" scale={1} slideUrls={urls} />)

    unmount()

    expect(urls.revoked).toEqual(['about:blank#0'])
  })
})
