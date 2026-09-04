import { useEffect, useState } from 'react'
import { defaultSlideUrls } from './slideUrlFactory'
import { wrapSlideHtml } from './wrapSlideHtml'

/**
 * The URL lifecycle behind a slide frame — layer 2's transport, per §7 of 10-architecture.md:
 * `<iframe sandbox="allow-scripts" … src={url}>`, explicitly *rather than* `srcdoc`.
 *
 * ## Two transports, one lifecycle
 *
 * *Which* URL a slide gets is `slideUrlFactory.ts`'s decision and depends on the host: `slide://`
 * under Electron, `blob:` in a plain browser. This module owns what is identical either way — that
 * exactly one URL is live per mounted frame, and that it is released when the html changes and when
 * the component unmounts.
 *
 * The delivery choice is not cosmetic. `blob:` is one of Fetch's three *local* schemes, so a
 * blob-loaded frame inherits a clone of the embedder's policy container (HTML, *determine
 * navigation params policy container*) — measured in Chromium on 2026-07-31 via
 * `experiments/init/harness/csp-blob-inheritance.mjs`, where the host page's `script-src 'self'`
 * blocks a blob frame's inline `<script>` exactly as it does a `srcdoc` control's. `slide://` is
 * not local, so it does not inherit, and its slides' inline script runs. That difference *is* M2.0.
 *
 * ## Why the URL is minted in an effect
 *
 * Both transports hand out a resource that leaks until it is released: a blob URL is a
 * document-lifetime entry in the browser's blob store, and a `slide://` id is an entry in the main
 * process's registry — the second one being the more expensive to lose, since it holds the whole
 * document in another process's heap. A URL minted in a render body (or in `useMemo`, which React
 * may discard and recompute) has no reliable cleanup partner, and every discarded one is leaked.
 * The cost is that the frame paints `about:blank` for one frame; the benefit is that every URL this
 * hook creates is released exactly once, including under StrictMode's double-invoke.
 *
 * Ordering note: React runs the previous effect's cleanup *before* the next effect, so an edit is
 * revoke-old-then-create-new, not create-swap-revoke. That is safe because the replacement `src`
 * lands in the same commit — the old document has already painted, and a still-in-flight load is
 * immediately superseded — but it is the opposite of what someone adding a `load`/`error` handler
 * to the frame would assume, so it is written down rather than left to be rediscovered.
 */

/**
 * The transport seam — the one thing `blobSlideUrls` and the `slide://` factory have in common.
 *
 * Injecting it is also what makes release *provable* in a test. Neither real implementation can be
 * observed from happy-dom: `URL.createObjectURL` there is not a real blob store, and there is no
 * main process to hold a registry. Asserting on the strings a stub hands out is the only way to pin
 * "the previous URL was released, exactly once, before the new one was used".
 */
export type SlideUrlFactory = {
  /**
   * Returns a URL for a complete HTML document — synchronously for the blob factory, as a promise
   * for the `slide://` factory, whose id has to come back from the main process.
   *
   * The union is not laziness about picking one. Forcing the blob path to be async would make the
   * fallback host paint an extra `about:blank` frame for no reason and would make every existing
   * lifecycle test a microtask dance; forcing the protocol path to be sync would mean minting the
   * id in the renderer, which loses both unguessability-by-construction and the guarantee that main
   * has the document before the frame asks for it. The hook handles both shapes and revokes exactly
   * once either way, which is the property that actually matters.
   */
  create: (html: string) => string | Promise<string>
  revoke: (url: string) => void
}

/**
 * A minted URL together with the html it was minted for.
 *
 * The pair is what lets a frame say *which* document a `load` event belongs to. When the html
 * changes, the old URL stays in the iframe until the new one has been published (see the cleanup
 * note below), and a `load` that fires in that window — an in-flight load, or the 404 the revoked
 * URL now answers with — is the old document's, not the new one's. Nothing outside the frame can
 * tell those apart from the event; the frame can, because it knows what its current `src` was
 * minted for. `SlideStage` relies on that to hold its pre-warm gate closed until the document it is
 * actually waiting for has loaded.
 */
export type SlideUrl = {
  readonly url: string
  readonly html: string
}

/**
 * The URL for `html`, or `null` on the very first render before the effect has run — and, on the
 * `slide://` path, until the publish round trip resolves.
 */
export function useSlideUrl(
  html: string,
  urls: SlideUrlFactory = defaultSlideUrls(),
): SlideUrl | null {
  const [url, setUrl] = useState<SlideUrl | null>(null)

  useEffect(() => {
    // `live` and `created` together cover all three orderings a URL and its cleanup can arrive in.
    // Sync create: `created` is set before the cleanup can possibly run, so the cleanup revokes it.
    // Async create resolving *before* cleanup: same. Async create resolving *after* cleanup: the
    // cleanup saw `created === null` and revoked nothing, so `settle` revokes it instead. Every
    // path revokes exactly once, and none of them can hand a stale URL to a frame that has moved on
    // — which for `slide://` is not a leaked blob but a document left sitting in main's registry.
    let live = true
    let created: string | null = null

    const settle = (value: string): void => {
      created = value
      if (live) setUrl({ url: value, html })
      else urls.revoke(value)
    }

    const pending = urls.create(wrapSlideHtml(html))
    if (typeof pending === 'string') {
      settle(pending)
    } else {
      void pending.then(settle, (error: unknown) => {
        // Delivery was refused — main rejects a publish that is oversized or that would overflow
        // the registry. Nothing was created, so there is nothing to release, and the frame keeps
        // whatever it was already showing rather than flashing to blank. A slide this size is
        // outside the document model's own per-member limit, so a refusal is the terminal state,
        // not a transient one worth retrying.
        //
        // It is logged rather than swallowed because this rejection is the *only* signal a failed
        // delivery ever produces: the frame simply stays blank, with nothing in either console and
        // no error state in the UI. A registry that has filled up (which a leak in main would
        // cause) presents identically to a slide that is genuinely too large, and neither is
        // diagnosable without this line.
        // oxlint-disable-next-line no-console -- the sole diagnostic for an undeliverable slide.
        console.error('slide delivery failed; the frame will keep its previous document', error)
      })
    }

    return () => {
      live = false
      if (created !== null) urls.revoke(created)
      // Deliberately *not* clearing the state here. Revoking only invalidates future loads; the
      // document already painted in the frame stays put, so leaving the old `src` in place until
      // the next effect writes the new one avoids a blank flash on every edit.
    }
  }, [html, urls])

  return url
}
