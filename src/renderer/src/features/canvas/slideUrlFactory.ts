import {
  slideDocumentIdFromUrl,
  slideDocumentUrl,
  type SlideSurface,
} from '../../../../shared/slide-protocol'
import { getBridge } from '../../host/bridge'
import { blobSlideUrls } from './blobSlideUrls'
import type { SlideUrlFactory } from './useSlideUrl'

/**
 * Which transport delivers a slide document, decided by a static fact about the host.
 *
 * There are two hosts for this renderer and they have different capabilities — the same split
 * `useMenuActions` makes for keyboard undo, and made the same way, by asking whether the preload
 * bridge exists rather than by racing two mechanisms:
 *
 *   Electron — `window.sloodge.publishSlide` exists. Slides are published into the main process's
 *              registry and served from `slide://`, a **non-local** scheme, so each slide document
 *              gets its own policy container and its inline `<script>` actually runs. This is the
 *              real product path and the only one where `interactive-js` works.
 *   A browser — no bridge: the evidence recorder serves the built renderer over http and the unit
 *              tests mount it in happy-dom. There is no main process to register a scheme, so
 *              delivery falls back to blob URLs. Static, CSS-animated and SMIL-animated slides —
 *              everything below `interactive-js` — render identically; inline script stays blocked
 *              by the host page's `script-src 'self'`, exactly as it was through M1.x.
 *
 * The fallback is a real degradation, not a polyfill, and it is deliberately not hidden: a recorded
 * video of an interactive slide will show it inert. The alternative — failing hard outside Electron
 * — would take the recorder and the whole component test suite down with it.
 */

/** The slide half of the preload surface, as much of it as the renderer needs to know about. */
export type SlideProtocolBridge = {
  publishSlide: (html: string) => Promise<string>
  revokeSlide: (id: string) => Promise<boolean>
}

/**
 * The slide bridge, or `undefined` when this renderer is not running inside Electron.
 *
 * **Both** functions are required before the bridge counts as present. A half-exposed API is not a
 * host we have — it is a version skew between the preload and renderer bundles, and treating it as
 * Electron would publish documents that could never be revoked: a main-process memory leak rather
 * than a rendering glitch. Falling back to blob URLs loses inline script and nothing else.
 */
export function getSlideProtocolBridge(): SlideProtocolBridge | undefined {
  const api = getBridge()
  const publishSlide = api?.publishSlide
  const revokeSlide = api?.revokeSlide
  if (typeof publishSlide !== 'function' || typeof revokeSlide !== 'function') {
    return undefined
  }
  return {
    publishSlide: (html) => publishSlide.call(api, html),
    revokeSlide: (id) => revokeSlide.call(api, id),
  }
}

/**
 * The `slide://` transport.
 *
 * `create` is **asynchronous** here and synchronous in the blob factory, which is why
 * `SlideUrlFactory.create` returns `string | Promise<string>`. Minting the id in the renderer to
 * keep the signature synchronous was the obvious alternative and it is wrong twice over: the id
 * would no longer be unguessable-by-construction (main would be storing under a key the renderer
 * chose), and the frame's `src` would be set before main had the document, so the very first load
 * of every slide would race the publish and lose. Awaiting the round trip costs one frame of
 * `about:blank`, which the hook already paints anyway.
 *
 * `revoke` is fire-and-forget by necessity: React effect cleanups are synchronous, so there is
 * nothing to await into. A rejected revoke is swallowed rather than reported because the only ways
 * it fails are a torn-down window and a double-revoke, both of which mean the document is already
 * gone — which is the outcome the caller wanted.
 *
 * `surface` picks the URL's host and with it the renderer process the frame lands in (M8.2 — see
 * `slideDocumentHost`): the stage and Present get a host per document, the rail's miniatures share
 * `thumbnails`, so a dozen animating thumbnails never share a main thread with the slide the user is
 * looking at, and neither does a hung neighbour. Main does not care which; the id is the key either
 * way.
 */
export function createProtocolSlideUrls(
  bridge: SlideProtocolBridge,
  surface: SlideSurface = 'stage',
): SlideUrlFactory {
  return {
    create: async (html) => slideDocumentUrl(await bridge.publishSlide(html), surface),
    revoke: (url) => {
      const id = slideDocumentIdFromUrl(url)
      if (id === null) return
      void bridge.revokeSlide(id).catch(() => {
        // Already gone, or the window is being torn down. Either way there is nothing to release.
      })
    },
  }
}

/** The transport for this host: `slide://` under Electron, blob URLs everywhere else. */
export function createSlideUrlFactory(
  bridge: SlideProtocolBridge | undefined = getSlideProtocolBridge(),
  surface: SlideSurface = 'stage',
): SlideUrlFactory {
  return bridge === undefined ? blobSlideUrls : createProtocolSlideUrls(bridge, surface)
}

const cached = new Map<SlideSurface, SlideUrlFactory>()

/**
 * The process-wide factory for a surface, memoized — one instance per surface, for the life of the
 * renderer.
 *
 * The memo is not a performance tweak — it is a correctness requirement. This is `useSlideUrl`'s
 * default argument and therefore one of its effect's dependencies, so a fresh object per render
 * would re-run the effect on every render: revoke, re-publish, new `src`, reloaded document. Every
 * keystroke would restart every slide in the deck.
 *
 * Resolved lazily rather than at module load so that the answer does not depend on whether this
 * module happened to be imported before the preload finished exposing `window.sloodge`. There is no
 * reset hook and none is needed: the gating decision is tested through `createSlideUrlFactory`,
 * which takes the bridge as an argument.
 */
export function defaultSlideUrls(surface: SlideSurface = 'stage'): SlideUrlFactory {
  let factory = cached.get(surface)
  if (factory === undefined) {
    factory = createSlideUrlFactory(getSlideProtocolBridge(), surface)
    cached.set(surface, factory)
  }
  return factory
}
