/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blobSlideUrls } from '../../../src/renderer/src/features/canvas/blobSlideUrls'
import {
  createProtocolSlideUrls,
  createSlideUrlFactory,
  defaultSlideUrls,
  getSlideProtocolBridge,
  type SlideProtocolBridge,
} from '../../../src/renderer/src/features/canvas/slideUrlFactory'
import type { SloodgeBridge } from '../../../src/renderer/src/host/bridge'

const ID = 'b'.repeat(32)

const publish = async (): Promise<string> => ID
const revoke = async (): Promise<boolean> => true

function fakeBridge(): SlideProtocolBridge & { published: string[]; revoked: string[] } {
  const published: string[] = []
  const revoked: string[] = []
  return {
    published,
    revoked,
    publishSlide: async (html) => {
      published.push(html)
      return ID
    },
    revokeSlide: async (id) => {
      revoked.push(id)
      return true
    },
  }
}

afterEach(() => {
  delete window.sloodge
  vi.restoreAllMocks()
})

/**
 * The host gate, made the same way `useMenuActions` makes its own: by asking whether the preload
 * bridge exists, not by racing two mechanisms. Under Electron slides go over `slide://` and their
 * inline script runs; in the recorder and in happy-dom they fall back to blob URLs and it does not.
 */
describe('host gating', () => {
  it('selects the blob transport when there is no bridge at all', () => {
    expect(getSlideProtocolBridge()).toBeUndefined()
    expect(createSlideUrlFactory()).toBe(blobSlideUrls)
  })

  it('selects the protocol transport when the bridge is complete', () => {
    const bridge = fakeBridge()
    window.sloodge = { onMenuAction: () => () => undefined, ...bridge }

    expect(getSlideProtocolBridge()).toBeDefined()
    expect(createSlideUrlFactory()).not.toBe(blobSlideUrls)
  })

  /**
   * A half-exposed API is a version skew between the preload and renderer bundles, not a host we
   * have. Treating it as Electron would publish documents that could never be revoked — a leak in
   * *another process*, which no browser GC reclaims.
   */
  it.each<[string, Record<string, unknown>]>([
    ['publishSlide missing', { revokeSlide: revoke }],
    ['revokeSlide missing', { publishSlide: publish }],
    ['both missing', {}],
    ['publishSlide not callable', { publishSlide: 'yes', revokeSlide: revoke }],
    ['revokeSlide not callable', { publishSlide: publish, revokeSlide: 42 }],
  ])('falls back to blob when %s', (_label, partial) => {
    window.sloodge = {
      onMenuAction: () => () => undefined,
      ...partial,
    } as unknown as SloodgeBridge

    expect(getSlideProtocolBridge()).toBeUndefined()
    expect(createSlideUrlFactory()).toBe(blobSlideUrls)
  })

  /**
   * Not a performance tweak: this is `useSlideUrl`'s default argument and therefore one of its
   * effect's dependencies. A fresh object per render would re-run the effect every render —
   * revoke, re-publish, new `src` — restarting every slide in the deck on every keystroke.
   */
  it('returns one stable factory instance process-wide', () => {
    expect(defaultSlideUrls()).toBe(defaultSlideUrls())
  })
})

describe('the slide:// transport', () => {
  it('publishes the document and returns its slide:// url', async () => {
    const bridge = fakeBridge()
    const urls = createProtocolSlideUrls(bridge)

    await expect(urls.create('<html>doc</html>')).resolves.toBe(`slide://${ID}/`)
    expect(bridge.published).toEqual(['<html>doc</html>'])
  })

  it('revokes by the id inside the url it was handed back', () => {
    const bridge = fakeBridge()
    const urls = createProtocolSlideUrls(bridge)

    urls.revoke(`slide://${ID}/`)

    expect(bridge.revoked).toEqual([ID])
  })

  // `revoke` is handed whatever is in the frame's `src`. Parsing it rather than slicing means a
  // value that is not one of ours can never be forwarded to main as if it were an id.
  it.each([
    ['a blob url', 'blob:http://localhost/x'],
    ['an http url', 'http://example.com/'],
    ['a malformed id host', 'slide://nope/'],
    ['gibberish', 'not a url'],
  ])('ignores a revoke of %s', (_label, url) => {
    const bridge = fakeBridge()
    createProtocolSlideUrls(bridge).revoke(url)

    expect(bridge.revoked).toEqual([])
  })

  /**
   * Effect cleanups are synchronous, so there is nothing to await a revoke into. The only ways it
   * rejects are a torn-down window and a double-revoke — both meaning the document is already gone,
   * which is what the caller wanted — so it must not surface as an unhandled rejection during
   * React's teardown.
   */
  it('swallows a failed revoke instead of rejecting into React teardown', async () => {
    // Watch for an *actual* unhandled rejection, not just a synchronous throw — the rejection is
    // async, so asserting only `not.toThrow()` would stay green even if the `.catch()` were deleted.
    const unhandled: unknown[] = []
    const onUnhandled = (event: PromiseRejectionEvent): void => {
      event.preventDefault()
      unhandled.push(event.reason)
    }
    window.addEventListener('unhandledrejection', onUnhandled)

    const bridge: SlideProtocolBridge = {
      publishSlide: async () => ID,
      revokeSlide: async () => {
        throw new Error('window gone')
      },
    }

    expect(() => {
      createProtocolSlideUrls(bridge).revoke(`slide://${ID}/`)
    }).not.toThrow()

    // Let the rejected revoke settle and any unhandled-rejection microtask fire.
    await new Promise((resolve) => setTimeout(resolve, 0))
    window.removeEventListener('unhandledrejection', onUnhandled)

    expect(unhandled).toEqual([])
  })

  it('propagates a refused publish so the hook can keep the previous document', async () => {
    const bridge: SlideProtocolBridge = {
      publishSlide: async () => {
        throw new Error('too large')
      },
      revokeSlide: async () => true,
    }

    await expect(createProtocolSlideUrls(bridge).create('<html>x</html>')).rejects.toThrow(
      'too large',
    )
  })
})
