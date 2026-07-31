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
 * - `standard: true` — makes `slide://<id>/` parse as a hierarchical URL with a real host, so the
 *   document gets an origin (`slide://<id>`) instead of being opaque-by-scheme. Without it Chromium
 *   treats the URL as non-hierarchical, relative-URL resolution inside the document misbehaves and
 *   the security origin is unusable. Note this is *not* what escapes CSP inheritance — that follows
 *   from `slide` simply not being one of Fetch's three local schemes (`about`, `blob`, `data`), and
 *   holds for standard and non-standard custom schemes alike.
 *
 * - `secure: true` — registers the scheme as *potentially trustworthy*, so slide documents are
 *   secure contexts. Two things need it. Chromium blocks a secure page from framing insecure
 *   content as mixed content, and the packaged app's renderer must be able to embed the frame;
 *   and a slide is not a secure context otherwise, which silently removes APIs the slide contract
 *   permits. It grants the scheme no privilege over the app: the frame is still an opaque origin
 *   from `sandbox="allow-scripts"` with no `allow-same-origin`.
 *
 * - `supportFetchAPI: false` — the slide contract forbids network at runtime and the injected
 *   policy says `connect-src 'none'`, so no slide has any business `fetch`-ing anything, least of
 *   all another `slide://` URL. Leaving it off means the scheme answers navigations only; a
 *   document cannot use it as a read primitive against sibling slides even if it guessed an id.
 *
 * - `corsEnabled: false` — follows from the above. There are no cross-origin reads to enable
 *   because there are no subresource loads at all: slides inline every asset as a `data:` URI
 *   (§3.5 of 30-slide-format.md).
 *
 * - `bypassCSP: false` — the load-bearing negative. This flag makes a scheme's responses ignore CSP
 *   entirely; on the one scheme that carries semi-untrusted model-generated code it would undo the
 *   whole of sandbox layer 3.
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
 */
function trackPublisher(registry: SlideRegistry, sender: WebContents): void {
  if (trackedPublishers.has(sender)) return
  trackedPublishers.add(sender)

  const drop = (): void => {
    registry.revokeOwner(sender.id)
  }

  sender.on('destroyed', drop)
  sender.on('render-process-gone', drop)
  sender.on('did-start-navigation', (details) => {
    // Subframe navigations are the slides themselves loading; only the *app* document going away
    // invalidates the whole set. A same-document navigation keeps the renderer and its frames.
    if (details.isMainFrame && !details.isSameDocument) drop()
  })
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

  ipcMain.handle(SLIDE_REVOKE_CHANNEL, (_event, payload: unknown): SlideRevokeResponse => {
    const id = (payload as { id?: unknown } | null)?.id
    if (!isSlideDocumentId(id)) {
      throw new Error('slide:revoke requires a slide document id')
    }
    return { revoked: registry.revoke(id) }
  })

  return registry
}
