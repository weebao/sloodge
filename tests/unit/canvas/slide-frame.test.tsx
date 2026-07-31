/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SlideFrame, SLIDE_SANDBOX } from '../../../src/renderer/src/features/canvas/SlideFrame'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'

afterEach(() => {
  cleanup()
})

const SLIDE_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'
const HTML = createStarterSlideHtml({ id: SLIDE_ID, title: 'First' })
const OTHER_HTML = createStarterSlideHtml({ id: SLIDE_ID, title: 'Second' })

function frame(): HTMLIFrameElement {
  return screen.getByTitle('slide') as HTMLIFrameElement
}

describe('SlideFrame sandbox invariants', () => {
  it('renders the slide through srcdoc, not a src URL', () => {
    render(<SlideFrame html={HTML} title="slide" scale={0.5} />)

    const srcdoc = frame().getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('data-sl-slide="s_01H8XQZ4P7K2M9NB3VYRTC6FDA"')
    expect(srcdoc).toContain('>First<')
    // The CSP wrapper (sandbox layer 3) is applied on the way in.
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"')
    expect(frame().getAttribute('src')).toBeNull()
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

  it('clamps a negative scale to an empty box rather than mirroring the slide', () => {
    const { container } = render(<SlideFrame html={HTML} title="slide" scale={-2} />)

    expect((container.firstElementChild as HTMLElement).style.width).toBe('0px')
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
  // Writing `srcdoc` reloads the document: animations restart from frame zero and any interactive
  // state is lost. A window resize must therefore not touch it — only the transform.
  it('does not reload the document when only the scale changes', () => {
    const { rerender } = render(<SlideFrame html={HTML} title="slide" scale={0.25} />)
    const before = frame()
    const srcdocBefore = before.getAttribute('srcdoc')

    rerender(<SlideFrame html={HTML} title="slide" scale={0.75} />)

    // Same DOM node (no remount) and byte-identical srcdoc (no reload).
    expect(frame()).toBe(before)
    expect(frame().getAttribute('srcdoc')).toBe(srcdocBefore)
    expect(frame().style.transform).toBe('scale(0.75)')
  })

  it('re-renders the document when, and only when, the html changes', () => {
    const { rerender } = render(<SlideFrame html={HTML} title="slide" scale={1} />)
    const before = frame()

    rerender(<SlideFrame html={OTHER_HTML} title="slide" scale={1} />)

    expect(frame().getAttribute('srcdoc')).toContain('>Second<')
    expect(frame().getAttribute('srcdoc')).not.toContain('>First<')
    // Updated in place: React swaps the attribute, so the element identity survives.
    expect(frame()).toBe(before)
  })
})
