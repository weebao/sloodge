import { ipcMain, protocol, type WebContents } from 'electron'
import {
  isPublishableSlideHtml,
  isSlideDocumentId,
  SLIDE_SCHEME,
} from '../../shared/slide-protocol'
import {
  SLIDE_PUBLISH_CHANNEL,
  SLIDE_REVOKE_CHANNEL,
  type SlidePublishResponse,
  type SlideRevokeResponse,
} from '../../shared/ipc-contract'
import { SlideRegistry } from './registry'
import { resolveSlideRequest } from './slideResponse'

/**
 * The `electron`-touching half of `slide://` delivery. Everything with a decision in it lives in
 * `registry.ts` and `slideResponse.ts`, which import nothing and are unit-tested; this file is
 * wiring, and is kept thin enough to review by eye.
 */

/**
 * Scheme privileges, and why each one is set the way it is.
 *
 * Must be called **before** `app.whenReady()` — `registerSchemesAsPrivileged` throws once the app
 * is ready, because Chromium's scheme registry is read during renderer startup and is immutable
 * after. That is why this is invoked at module scope in `src/main/index.ts` rather than inside the
 * ready handler.
 *
 * - `standard: true` — makes `slide://slides/<id>/` parse as a hierarchical URL with a real host,
 *   so the document gets an origin (`slide://slides`) instead of being opaque-by-scheme. Without it
 *   Chromium treats the URL as non-hierarchical, relative-URL resolution inside the document
 *   misbehaves and the security origin is unusable. Note this is *not* what escapes CSP inheritance
 *   — that follows from `slide` simply not being one of Fetch's three local schemes (`about`,
 *   `blob`, `data`), and holds for standard and non-standard custom schemes alike. The host is the
 *   same for every document since M8.2, deliberately: Chromium groups sandboxed frames into
 *   processes by site, so one host is what turns a hundred slide processes into one (see
 *   `slideDocumentUrl`).
 *
 * - `secure: true` — registers the scheme as *potentially trustworthy*, so slide documents are
 *   secure contexts. Two things need it. Chromium blocks a secure page from framing insecure
 *   content as mixed content, and the packaged app's renderer must be able to embed the frame;
 *   and a slide is not a secure context otherwise, which silently removes APIs the slide contract
 *   permits. It grants the scheme no privilege over the app: the frame is still an opaque origin
 *   from `sandbox="allow-scripts"` with no `allow-same-origin`.
 *
 * - `supportFetchAPI: false` — defence in depth, **not** the operative guard it was first described
 *   as. The slide contract forbids runtime network and the injected `connect-src 'none'` already
 *   blocks a slide from `fetch`-ing a sibling `slide://` URL: measured with `supportFetchAPI: true`,
 *   the sibling read still failed, because the slide's own policy governs regardless. Leaving it off
 *   is correct hygiene — the scheme answers navigations only — but the sibling-read boundary is
 *   `connect-src`, not this flag.
 *
 * - `corsEnabled: false` — follows from the above. There are no cross-origin reads to enable
 *   because there are no subresource loads at all: slides inline every asset as a `data:` URI
 *   (§3.5 of 30-slide-format.md).
 *
 * - `bypassCSP: false` — correct, but weaker than "load-bearing" once claimed. This flag governs
 *   whether *other* pages may load `slide://` resources despite **their** CSP; it does not exempt a
 *   slide document's own outbound requests from the slide's own policy. Measured: flipping it (and
 *   `supportFetchAPI`) to `true` left containment intact — zero exfil, sibling reads still rejected —
 *   because layer 3 is what governs the slide. Kept `false` as hygiene; the real boundary is the
 *   injected policy plus the opaque origin.
 *
 * - `allowServiceWorkers: false` — a service worker outlives the document that registered it and
 *   would survive revoke, which is precisely the lifetime guarantee this milestone is built on.
 *
 * - `stream: false` — documents are served whole from memory; there is nothing to stream.
 */
export function registerSlideSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SLIDE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        bypassCSP: false,
        allowServiceWorkers: false,
        stream: false,
      },
    },
  ])
}

/**
 * Renderers whose teardown hooks are already installed.
 *
 * A `WeakSet` rather than a `Set` of ids so a destroyed `WebContents` is not retained here, and so
 * the "have I hooked this one" question cannot be answered wrongly by an id Electron reused.
 */
const trackedPublishers = new WeakSet<WebContents>()

/**
 * Make sure this renderer's documents are released when the renderer goes away.
 *
 * The renderer releases documents one at a time as frames unmount, and that covers everything
 * *except* the renderer ceasing to exist: a reload, a dev-server HMR full refresh, or a crashed
 * render process all destroy it without running a single React effect cleanup. Every document it
 * published would then be stranded in main's heap until the app quits.
 *
 * That leak is worse than it sounds because of how it ends. Once the aggregate budget is gone,
 * `publish` refuses, the IPC handler rejects, and the renderer's hook treats it as an undeliverable
 * slide — so the visible symptom of "you have reloaded forty times" is slides that quietly render
 * blank. Hence three hooks, not one: navigation covers reload, `destroyed` covers close, and
 * `render-process-gone` covers the crash that precedes an automatic reload.
 *
 * The navigation hook is `did-navigate`, deliberately, and the choice is load-bearing. An earlier
 * revision used `did-start-navigation`, which fires the instant a navigation is *attempted* —
 * including main-frame navigations that the app's own `will-navigate` guard then refuses, and
 * including an ordinary anchor click or a file dropped on the window. That wiped the whole registry
 * for a navigation that never happened, leaving every live slide frame pointing at a `slide://` URL
 * whose document had just been reclaimed — the deck poisoned, blank on the next reload of any frame,
 * with nothing in any log. `did-navigate` fires only for a main-frame navigation that has actually
 * committed, which is exactly the set that invalidates the renderer's published documents; it still
 * covers reload and HMR full refresh (a committed navigation to the same URL), and it does not fire
 * for in-page/hash navigations (those keep the document and its frames). Verified by the mocked-IPC
 * test in `tests/unit/slide/slide-protocol.test.ts` — a blocked navigation must leave the registry
 * intact, a committed one must clear it.
 */
function trackPublisher(registry: SlideRegistry, sender: WebContents): void {
  if (trackedPublishers.has(sender)) return
  trackedPublishers.add(sender)

  const drop = (): void => {
    registry.revokeOwner(sender.id)
  }

  sender.on('destroyed', drop)
  sender.on('render-process-gone', drop)
  // `did-navigate`, NOT `did-start-navigation`: the latter fires for navigations that are then
  // refused (a `will-navigate` block, an anchor click), which would empty the registry while the
  // page stays put. This one fires only after a main-frame navigation commits.
  sender.on('did-navigate', drop)
}

/**
 * Install the handler and the publish/revoke channels. Call once, after `app.whenReady()`.
 *
 * Returns the registry so the caller can `clear()` it on teardown; the caller owning that is what
 * keeps this module free of window lifecycle.
 */
export function installSlideProtocol(registry: SlideRegistry = new SlideRegistry()): SlideRegistry {
  protocol.handle(SLIDE_SCHEME, (request) => {
    const { status, headers, body } = resolveSlideRequest(registry, {
      url: request.url,
      method: request.method,
    })
    return new Response(body, { status, headers })
  })

  /**
   * Both handlers validate their payload before touching the registry, and both reject rather than
   * returning a sentinel. `ipcMain.handle` turns a thrown error into a rejected promise on the
   * renderer side, which is what `useSlideUrl` treats as "this slide could not be delivered".
   *
   * The preload screens the same values first. That is not duplication to be factored out: the
   * preload's copy is a fast path that keeps a 64 MB string from crossing the bridge at all, and
   * this copy is the one that is actually trusted, because `ipcRenderer.invoke` is reachable from
   * any code running in the renderer regardless of what the preload does.
   */
  ipcMain.handle(SLIDE_PUBLISH_CHANNEL, (event, payload: unknown): SlidePublishResponse => {
    const html = (payload as { html?: unknown } | null)?.html
    if (!isPublishableSlideHtml(html)) {
      throw new Error('slide:publish requires an html string within the size limit')
    }
    trackPublisher(registry, event.sender)
    const result = registry.publish(html, event.sender.id)
    if (!result.ok) {
      throw new Error(`slide:publish refused (${result.refusal.reason})`)
    }
    return { id: result.id }
  })

  ipcMain.handle(SLIDE_REVOKE_CHANNEL, (event, payload: unknown): SlideRevokeResponse => {
    const id = (payload as { id?: unknown } | null)?.id
    if (!isSlideDocumentId(id)) {
      throw new Error('slide:revoke requires a slide document id')
    }
    // Owner-scoped, mirroring publish: a renderer may only revoke what it published, so one window
    // cannot drop another window's slide. Not exploitable today (ids are 128-bit and never leave
    // the publishing renderer), but it makes the ownership model uniform rather than half-applied.
    return { revoked: registry.revoke(id, event.sender.id) }
  })

  return registry
}
