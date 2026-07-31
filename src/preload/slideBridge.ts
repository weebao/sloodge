import { SLIDE_PUBLISH_CHANNEL, SLIDE_REVOKE_CHANNEL } from '../shared/ipc-contract'
import { isPublishableSlideHtml, isSlideDocumentId } from '../shared/slide-protocol'

/**
 * The renderer's end of `slide://` publication, as a plain function over an injected `invoke`.
 *
 * It lives outside `index.ts` for the same reason `menuActionHandler.ts` does: that file imports
 * `electron` at module scope, so a unit test importing it throws before a single assertion runs.
 * The electron-touching half stays one line there; the decisions — *what may cross, in either
 * direction* — are here and are testable.
 *
 * Validation runs on the **way out and the way back**. Outbound is the cheap screen described in
 * `isPublishableSlideHtml`: refusing an oversized document here keeps a 64 MB string from being
 * structured-cloned across the process boundary at all, which is a real cost, not a theoretical
 * one. It is emphatically not a security boundary — anything running in the renderer can call
 * `ipcRenderer.invoke` without going through this function — which is why main re-checks exactly.
 *
 * Inbound matters more than it looks. The id main returns is about to be interpolated into a URL
 * and handed to an iframe's `src`. Checking its shape here means the renderer can never be induced
 * to navigate a frame to something that merely *starts* `slide://` — the same check-then-use
 * discipline `toSafeExternalUrl` applies on the way out of the app.
 */

export type SlideInvoke = (channel: string, payload: unknown) => Promise<unknown>

export type SlideBridge = {
  /** Publish a slide document; resolves with its opaque id. */
  publishSlide: (html: string) => Promise<string>
  /** Release a published document. Resolves `true` if it was still live. */
  revokeSlide: (id: string) => Promise<boolean>
}

export function createSlideBridge(invoke: SlideInvoke): SlideBridge {
  return {
    publishSlide: async (html) => {
      if (!isPublishableSlideHtml(html)) {
        throw new TypeError('publishSlide requires an html string within the size limit')
      }
      const response = await invoke(SLIDE_PUBLISH_CHANNEL, { html })
      const id = (response as { id?: unknown } | null)?.id
      if (!isSlideDocumentId(id)) {
        throw new TypeError('slide:publish returned a malformed id')
      }
      return id
    },

    revokeSlide: async (id) => {
      if (!isSlideDocumentId(id)) {
        throw new TypeError('revokeSlide requires a slide document id')
      }
      const response = await invoke(SLIDE_REVOKE_CHANNEL, { id })
      return (response as { revoked?: unknown } | null)?.revoked === true
    },
  }
}
