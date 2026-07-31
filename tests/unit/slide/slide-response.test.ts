import { describe, expect, it } from 'vitest'
import { SlideRegistry } from '../../../src/main/slide/registry'
import { resolveSlideRequest, slideResponseHeaders } from '../../../src/main/slide/slideResponse'
import { SLIDE_CSP, slideDocumentUrl } from '../../../src/shared/slide-protocol'

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
    const id = new URL(url).hostname

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
   * `slide://<id>/x/../` normalizes to `slide://<id>/` in the URL parser, before this function sees
   * a pathname — so it serves the document, and that is correct rather than a bypass: the id is the
   * *host*, and the host is unchanged. Pinned because "a traversal resolved to content" reads like
   * a finding until you notice that there is only ever one document per host and no filesystem
   * underneath. Comparing `request.url` as a raw string instead would have been the real bug.
   */
  it('serves the document for a path that normalizes back to the root', () => {
    const { registry, url } = published('<html>secret</html>')
    const response = resolveSlideRequest(registry, { url: `${url}x/../` })

    expect(response.status).toBe(200)
    expect(new URL(`${url}x/../`).pathname).toBe('/')
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

  // Node's URL leaves `slide://<id>` with an empty pathname (non-special scheme), while Chromium
  // canonicalizes the trailing slash in before `protocol.handle` sees it. Unreachable in
  // production, but a host-only URL must not 404 in a way indistinguishable from a registry miss.
  it('serves the document for the host-only url form', () => {
    const { registry, url } = published('<html>x</html>')
    const hostOnly = url.replace(/\/$/, '')

    expect(new URL(hostOnly).pathname).toBe('')
    expect(resolveSlideRequest(registry, { url: hostOnly }).status).toBe(200)
  })

  it('404s a url on another scheme even when the host is a valid id', () => {
    const { registry, url } = published('<html>secret</html>')
    const id = new URL(url).hostname

    expect(resolveSlideRequest(registry, { url: `http://${id}/` }).status).toBe(404)
  })
})
