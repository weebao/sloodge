import { describe, expect, it } from 'vitest'
import { SlideRegistry } from '../../../src/main/slide/registry'
import { resolveSlideRequest, slideResponseHeaders } from '../../../src/main/slide/slideResponse'
import {
  SLIDE_CSP,
  SLIDE_STAGE_HOST,
  SLIDE_THUMBNAIL_HOST,
  slideDocumentIdFromUrl,
  slideDocumentUrl,
} from '../../../src/shared/slide-protocol'

function published(html: string): { registry: SlideRegistry; url: string } {
  const registry = new SlideRegistry()
  const result = registry.publish(html)
  if (!result.ok) throw new Error('publish failed')
  return { registry, url: slideDocumentUrl(result.id) }
}

describe('slide:// response headers', () => {
  /**
   * The header half of the slide's policy. With `slide://` escaping policy-container inheritance,
   * there is no host CSP underneath any more — this header and the `<meta>` `wrapSlideHtml` injects
   * are the entire policy on a document full of model-generated code.
   */
  it('carries the slide CSP verbatim', () => {
    expect(slideResponseHeaders()['Content-Security-Policy']).toBe(SLIDE_CSP)
  })

  // The point of the milestone: this policy must *permit* the slide's inline script, or `slide://`
  // delivery buys nothing over the blob path it replaced.
  it('permits inline script, which is the whole reason the scheme exists', () => {
    expect(slideResponseHeaders()['Content-Security-Policy']).toContain(
      "script-src 'unsafe-inline'",
    )
  })

  it('declares html explicitly and forbids sniffing it into something else', () => {
    const headers = slideResponseHeaders()
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })

  // A cached entry would keep a revoked document reachable after the registry forgot it, which
  // would quietly undo the lifetime guarantee the renderer's revoke path is built on.
  it('is never cached', () => {
    expect(slideResponseHeaders()['Cache-Control']).toBe('no-store')
  })
})

describe('resolveSlideRequest', () => {
  it('serves a published document with a 200 and the full header set', () => {
    const html = '<!doctype html><html><body>hi</body></html>'
    const { registry, url } = published(html)

    const response = resolveSlideRequest(registry, { url, method: 'GET' })

    expect(response.status).toBe(200)
    expect(response.body).toBe(html)
    expect(response.headers['Content-Security-Policy']).toBe(SLIDE_CSP)
  })

  it('404s an id that was never published', () => {
    const registry = new SlideRegistry()
    const response = resolveSlideRequest(registry, { url: slideDocumentUrl('a'.repeat(32)) })

    expect(response.status).toBe(404)
  })

  it('404s an id after it is revoked', () => {
    const html = '<html>gone</html>'
    const { registry, url } = published(html)
    const id = slideDocumentIdFromUrl(url)

    expect(resolveSlideRequest(registry, { url }).status).toBe(200)
    registry.revoke(id)
    expect(resolveSlideRequest(registry, { url }).status).toBe(404)
  })

  /**
   * A refusal must never look like a document. If it carried `text/html` an error string would be
   * parsed as markup in the frame, and if it carried the slide CSP a reader could mistake a 404 for
   * a policy-bearing response. Asserted over **all three** refusal statuses, not just the 404: they
   * share a private `refusal()` helper today, but a future divergence in one branch would otherwise
   * fail nothing.
   */
  it.each<[string, { url: string; method?: string }]>([
    ['404 unknown id', { url: slideDocumentUrl('a'.repeat(32)) }],
    ['405 wrong method', { url: slideDocumentUrl('a'.repeat(32)), method: 'POST' }],
    ['400 unparseable url', { url: 'not a url' }],
  ])('answers %s as inert text with no policy of its own', (_label, request) => {
    const response = resolveSlideRequest(new SlideRegistry(), request)

    expect(response.headers['Content-Type']).toBe('text/plain; charset=utf-8')
    expect(response.headers['Content-Security-Policy']).toBeUndefined()
  })

  // Distinguishing "no such id" from "bad path" would hand a slide a probe for its siblings' ids.
  it('gives an unknown id and a bad path the same answer', () => {
    const { registry, url } = published('<html>secret</html>')
    const missing = resolveSlideRequest(registry, { url: slideDocumentUrl('a'.repeat(32)) })
    const badPath = resolveSlideRequest(registry, { url: `${url}deeper` })

    expect(badPath.status).toBe(missing.status)
    expect(badPath.body).toBe(missing.body)
  })

  it.each([
    ['a subpath', (url: string) => `${url}index.html`],
    ['a nested path', (url: string) => `${url}a/b/c`],
    ['an escaped-separator path', (url: string) => `${url}%2e%2e%2fetc%2fpasswd`],
    ['a traversal above the root', (url: string) => `${url}../../../etc/passwd`],
  ])('404s %s rather than serving the document', (_label, mangle) => {
    const { registry, url } = published('<html>secret</html>')
    const response = resolveSlideRequest(registry, { url: mangle(url) })

    expect(response.status).toBe(404)
    expect(response.body).not.toContain('secret')
  })

  /**
   * `slide://slides/<id>/x/../` normalizes to `slide://slides/<id>/` in the URL parser, before this
   * function sees a pathname — so it serves the document, and that is correct rather than a bypass:
   * it is the same resource, and there is no filesystem underneath for a `..` to climb. Pinned
   * because "a traversal resolved to content" reads like a finding until you notice that the only
   * thing a path can resolve *to* is a registry key. Comparing `request.url` as a raw string
   * instead would have been the real bug.
   */
  it('serves the document for a path that normalizes back to the document', () => {
    const { registry, url } = published('<html>secret</html>')
    const response = resolveSlideRequest(registry, { url: `${url}x/../` })

    expect(response.status).toBe(200)
    expect(new URL(`${url}x/../`).pathname).toBe(new URL(url).pathname)
  })

  it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('refuses %s with a 405', (method) => {
    const { registry, url } = published('<html>x</html>')
    const response = resolveSlideRequest(registry, { url, method })

    expect(response.status).toBe(405)
    expect(response.body).not.toContain('<html>')
  })

  it('400s a url that does not parse', () => {
    const registry = new SlideRegistry()
    expect(resolveSlideRequest(registry, { url: 'not a url' }).status).toBe(400)
  })

  // The accepted path is exactly `/<id>/`. The id without its slash, the host alone, and the
  // pre-M8.2 id-as-host form are all 404s, so there is one legal spelling of every document.
  it.each([
    ['the id without its trailing slash', (url: string) => url.replace(/\/$/, '')],
    ['the host alone', () => `slide://${SLIDE_STAGE_HOST}/`],
    ['an unknown host', (url: string) => url.replace(`//${SLIDE_STAGE_HOST}/`, '//elsewhere/')],
    ['the id as the host', (url: string) => `slide://${slideDocumentIdFromUrl(url) ?? ''}/`],
  ])('404s %s', (_label, mangle) => {
    const { registry, url } = published('<html>secret</html>')
    const response = resolveSlideRequest(registry, { url: mangle(url) })

    expect(response.status).toBe(404)
    expect(response.body).not.toContain('secret')
  })

  // The same document is reachable on every surface host; the host chooses a process, not a key.
  it('serves the document on the thumbnails host too', () => {
    const { registry, url } = published('<html>mini</html>')
    const id = slideDocumentIdFromUrl(url) ?? ''
    const response = resolveSlideRequest(registry, {
      url: slideDocumentUrl(id, SLIDE_THUMBNAIL_HOST),
    })

    expect(response.status).toBe(200)
    expect(response.body).toBe('<html>mini</html>')
  })

  it('404s a url on another scheme even with the same host and path', () => {
    const { registry, url } = published('<html>secret</html>')

    expect(resolveSlideRequest(registry, { url: url.replace(/^slide:/, 'http:') }).status).toBe(404)
  })
})
