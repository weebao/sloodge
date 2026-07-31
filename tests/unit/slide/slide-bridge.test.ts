import { describe, expect, it, vi } from 'vitest'
import { createSlideBridge } from '../../../src/preload/slideBridge'
import { SLIDE_PUBLISH_CHANNEL, SLIDE_REVOKE_CHANNEL } from '../../../src/shared/ipc-contract'
import { MAX_SLIDE_HTML_BYTES } from '../../../src/shared/slide-protocol'

const ID = 'a'.repeat(32)

describe('preload slide bridge — outbound', () => {
  it('invokes the publish channel with the html and returns the id', async () => {
    const invoke = vi.fn().mockResolvedValue({ id: ID })
    const bridge = createSlideBridge(invoke)

    await expect(bridge.publishSlide('<html>x</html>')).resolves.toBe(ID)
    expect(invoke).toHaveBeenCalledWith(SLIDE_PUBLISH_CHANNEL, { html: '<html>x</html>' })
  })

  it('invokes the revoke channel with the id', async () => {
    const invoke = vi.fn().mockResolvedValue({ revoked: true })
    const bridge = createSlideBridge(invoke)

    await expect(bridge.revokeSlide(ID)).resolves.toBe(true)
    expect(invoke).toHaveBeenCalledWith(SLIDE_REVOKE_CHANNEL, { id: ID })
  })

  it.each([
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('rejects %s as html without crossing the bridge', async (_label, value) => {
    const invoke = vi.fn()
    const bridge = createSlideBridge(invoke)

    await expect(bridge.publishSlide(value as unknown as string)).rejects.toThrow(TypeError)
    expect(invoke).not.toHaveBeenCalled()
  })

  /**
   * The screen exists to keep an oversized document from being structured-cloned across the process
   * boundary at all. It is a cost guard, not a security boundary — anything in the renderer can
   * call `ipcRenderer.invoke` directly — which is why main re-measures exactly.
   */
  it('refuses an oversized document without invoking', async () => {
    const invoke = vi.fn()
    const bridge = createSlideBridge(invoke)
    // Genuinely allocated, at the genuine production limit. A `{ length: … }` stand-in would be
    // rejected by the `typeof value === 'string'` arm and prove nothing about the size check; this
    // is one ASCII (one-byte) string of ~64 MB, which is the cost of testing the real boundary.
    const huge = 'a'.repeat(MAX_SLIDE_HTML_BYTES + 1)

    await expect(bridge.publishSlide(huge)).rejects.toThrow(TypeError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['a short string', 'abc'],
    ['uppercase hex', 'A'.repeat(32)],
    ['a path', '../../etc/passwd'],
    ['a number', 7],
  ])('rejects %s as an id without crossing the bridge', async (_label, value) => {
    const invoke = vi.fn()
    const bridge = createSlideBridge(invoke)

    await expect(bridge.revokeSlide(value as unknown as string)).rejects.toThrow(TypeError)
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('preload slide bridge — inbound', () => {
  /**
   * The returned id is about to be interpolated into a URL and handed to an iframe's `src`.
   * Validating it here is the same check-then-use discipline `toSafeExternalUrl` applies on the way
   * out: the renderer must never be induced to navigate a frame to something that merely *starts*
   * `slide://`.
   */
  it.each([
    ['a malformed id', { id: 'nope' }],
    ['a url instead of an id', { id: 'slide://evil/' }],
    ['a missing id', {}],
    ['null', null],
    ['a non-object', 'ok'],
  ])('rejects %s coming back from main', async (_label, response) => {
    const bridge = createSlideBridge(vi.fn().mockResolvedValue(response))
    await expect(bridge.publishSlide('<html>x</html>')).rejects.toThrow(TypeError)
  })

  it('reports a revoke that main says did nothing', async () => {
    const bridge = createSlideBridge(vi.fn().mockResolvedValue({ revoked: false }))
    await expect(bridge.revokeSlide(ID)).resolves.toBe(false)
  })

  it('treats a malformed revoke response as "did nothing" rather than throwing', async () => {
    // Revoke's answer is advisory — the caller is an effect cleanup that has nothing to do with a
    // failure — so an unusable response degrades to `false` instead of producing an unhandled
    // rejection inside React's teardown.
    const bridge = createSlideBridge(vi.fn().mockResolvedValue(null))
    await expect(bridge.revokeSlide(ID)).resolves.toBe(false)
  })

  it('propagates a rejected invoke', async () => {
    const bridge = createSlideBridge(vi.fn().mockRejectedValue(new Error('refused')))
    await expect(bridge.publishSlide('<html>x</html>')).rejects.toThrow('refused')
  })
})
