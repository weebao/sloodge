/**
 * @vitest-environment happy-dom
 *
 * The in-frame agent script (§2.2), driven directly. The iframe never executes under happy-dom, so
 * calling `designBridgeFrameMain` against a real (happy-dom) document with a stand-in parent window
 * is the only way to exercise the message loop, the hit-test, and — the point of the whole design —
 * the frame-side source-identity check. `getBoundingClientRect` is stubbed non-zero because happy-dom
 * reports every box as 0×0, which the grabbable climb would otherwise treat as unselectable.
 */

/* oxlint-disable no-underscore-dangle -- the test reads the frame's `__slDesignBridge` install flag. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  designBridgeFrameMain,
  DESIGN_BRIDGE_SCRIPT,
  injectDesignBridge,
} from '../../../src/renderer/src/features/design/frameScript'
import {
  SL_HITTEST,
  SL_MAGIC,
  SL_PROTOCOL_VERSION,
  SL_READY,
  type SlHit,
} from '../../../src/shared/design/bridge-protocol'

const SLIDE = 's_x'

interface FakeParent {
  postMessage: ReturnType<typeof vi.fn>
}

function makeParent(): FakeParent {
  return { postMessage: vi.fn() }
}

/** Dispatch a message on `window` with a forced `source` (happy-dom drops a plain-object source). */
function postToFrame(data: unknown, source: unknown): void {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source, configurable: true })
  window.dispatchEvent(event)
}

function hitRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id: 42,
    dir: 'req',
    type: SL_HITTEST,
    slide: SLIDE,
    payload: { x: 100, y: 100, mode: 'select', alt: false },
    ...overrides,
  }
}

beforeEach(() => {
  // The install-once flag lives on the shared window; reset it so each test arms a fresh listener.
  delete (window as unknown as { __slDesignBridge?: boolean }).__slDesignBridge
  document.body.innerHTML =
    '<section data-sl-id="s_x:0" class="slide">' +
    '<div data-sl-id="s_x:1" class="chart">bars</div>' +
    '<span data-sl-ignore>motif</span>' +
    '</section>'
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 40,
    y: 60,
    width: 320,
    height: 84,
    left: 40,
    top: 60,
    right: 360,
    bottom: 144,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('designBridgeFrameMain', () => {
  it('does nothing when it is not framed (parent is itself)', () => {
    // Top-level window: window.parent === window. No stand-in, so the guard fires.
    expect(() => {
      designBridgeFrameMain()
    }).not.toThrow()
    expect((window as unknown as { __slDesignBridge?: boolean }).__slDesignBridge).toBeUndefined()
  })

  it('emits SL_READY to the trusted parent on boot, with the mapped count', () => {
    const parent = makeParent()
    designBridgeFrameMain(parent as unknown as Window)

    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    const [envelope] = parent.postMessage.mock.calls[0] as [Record<string, unknown>, string]
    expect(envelope['type']).toBe(SL_READY)
    expect(envelope['slide']).toBe(SLIDE)
    // Two addressable elements carry data-sl-id (the ignored span does not).
    expect((envelope['payload'] as { mappedCount: number }).mappedCount).toBe(2)
  })

  it('resolves a hit-test to the nearest data-sl-id, with rect and breadcrumb ancestry', () => {
    const parent = makeParent()
    const target = document.querySelector('[data-sl-id="s_x:1"]')
    document.elementFromPoint = vi.fn().mockReturnValue(target)

    designBridgeFrameMain(parent as unknown as Window)
    parent.postMessage.mockClear() // drop the SL_READY

    postToFrame(hitRequest(), parent)

    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    const [envelope] = parent.postMessage.mock.calls[0] as [Record<string, unknown>, string]
    expect(envelope['dir']).toBe('res')
    expect(envelope['id']).toBe(42)
    const hit = envelope['payload'] as SlHit
    expect(hit.slId).toBe('s_x:1')
    expect(hit.tag).toBe('div')
    expect(hit.classes).toEqual(['chart'])
    expect(hit.rect).toEqual({ x: 40, y: 60, width: 320, height: 84 })
    // The .slide section is the one addressable ancestor.
    expect(hit.ancestors.map((a) => a.slId)).toEqual(['s_x:0'])
  })

  it('replies with a null payload when nothing addressable is under the point', () => {
    const parent = makeParent()
    document.elementFromPoint = vi.fn().mockReturnValue(null)
    designBridgeFrameMain(parent as unknown as Window)
    parent.postMessage.mockClear()

    postToFrame(hitRequest(), parent)
    const [envelope] = parent.postMessage.mock.calls[0] as [Record<string, unknown>, string]
    expect(envelope['payload']).toBeNull()
  })

  it('IGNORES a message whose source is NOT the trusted parent — the spoofing guard', () => {
    const parent = makeParent()
    const target = document.querySelector('[data-sl-id="s_x:1"]')
    document.elementFromPoint = vi.fn().mockReturnValue(target)
    designBridgeFrameMain(parent as unknown as Window)
    parent.postMessage.mockClear()

    // Same well-formed request, but sourced from the window itself (a slide's own hostile script).
    postToFrame(hitRequest(), window)
    expect(parent.postMessage).not.toHaveBeenCalled()
  })

  it('ignores a request for a different slide, and a non-request direction', () => {
    const parent = makeParent()
    document.elementFromPoint = vi
      .fn()
      .mockReturnValue(document.querySelector('[data-sl-id="s_x:1"]'))
    designBridgeFrameMain(parent as unknown as Window)
    parent.postMessage.mockClear()

    postToFrame(hitRequest({ slide: 's_other' }), parent)
    postToFrame(hitRequest({ dir: 'res' }), parent)
    postToFrame(hitRequest({ payload: { x: 1, y: 2, mode: 'nope', alt: false } }), parent)
    expect(parent.postMessage).not.toHaveBeenCalled()
  })

  it('installs its listener at most once', () => {
    const parent = makeParent()
    document.elementFromPoint = vi
      .fn()
      .mockReturnValue(document.querySelector('[data-sl-id="s_x:1"]'))
    designBridgeFrameMain(parent as unknown as Window)
    designBridgeFrameMain(parent as unknown as Window) // second call must be inert
    // Only the first call announced readiness.
    expect(parent.postMessage).toHaveBeenCalledTimes(1)

    parent.postMessage.mockClear()
    postToFrame(hitRequest(), parent)
    // One listener → one response, not two.
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('DESIGN_BRIDGE_SCRIPT / injectDesignBridge', () => {
  it('is a data-sl-ignore script so it is never itself selectable', () => {
    expect(DESIGN_BRIDGE_SCRIPT.startsWith('<script data-sl-ignore>')).toBe(true)
    expect(DESIGN_BRIDGE_SCRIPT.endsWith('</script>')).toBe(true)
  })

  it('carries the shared wire constants (drift guard against the hard-coded copies)', () => {
    expect(DESIGN_BRIDGE_SCRIPT).toContain(SL_READY)
    expect(DESIGN_BRIDGE_SCRIPT).toContain(SL_HITTEST)
    expect(DESIGN_BRIDGE_SCRIPT).toContain('data-sl-id')
    expect(DESIGN_BRIDGE_SCRIPT).toContain('data-sl-ignore')
  })

  it('inserts the script immediately before the final </body>', () => {
    const out = injectDesignBridge('<html><body><p>x</p></body></html>')
    expect(out).toBe(`<html><body><p>x</p>${DESIGN_BRIDGE_SCRIPT}</body></html>`)
  })

  it('appends at the end when there is no body close tag', () => {
    const out = injectDesignBridge('<p>fragment</p>')
    expect(out).toBe(`<p>fragment</p>${DESIGN_BRIDGE_SCRIPT}`)
  })

  it('targets the LAST </body> when several appear in text', () => {
    const html = '<body><pre>&lt;/body&gt;</pre></body>'
    const out = injectDesignBridge(html)
    // The script lands before the real closing tag, which is the final one.
    expect(out.lastIndexOf(DESIGN_BRIDGE_SCRIPT)).toBe(
      out.lastIndexOf('</body>') - DESIGN_BRIDGE_SCRIPT.length,
    )
  })
})
