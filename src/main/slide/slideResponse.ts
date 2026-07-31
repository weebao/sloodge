import { SLIDE_CSP, SLIDE_DOCUMENT_PATH, SLIDE_SCHEME } from '../../shared/slide-protocol'
import type { SlideRegistry } from './registry'

/**
 * What the `slide://` handler answers, decided without touching `electron`.
 *
 * Splitting the decision from the `Response` construction is what makes the security-relevant part
 * — the status codes and, above all, the header set — assertable in a plain unit test. The wiring
 * in `protocol.ts` is then three lines with nothing to get wrong.
 */

export type SlideHttpResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Headers on a served slide document, and the reason each one is here.
 *
 * `Content-Security-Policy` is the header half of the *same* policy `wrapSlideHtml` injects as a
 * `<meta>`. Sending it twice is not redundancy for its own sake: CSP composes by intersection, so
 * two copies of one policy behave exactly like one copy, and the pair covers two different failure
 * modes. The header survives a document whose `<meta>` landed somewhere the parser did not honour
 * (the failure class that took five review rounds to eliminate from `cspInjectionOffset`), and it
 * applies from the first byte rather than from wherever in the parse the meta appears. The meta
 * survives the document being re-read from a context that is not this handler — an export pass, a
 * `WebContentsView` in present mode, a saved-out file. Neither alone is enough, which is the point:
 * with `slide://` escaping policy-container inheritance, there is no longer an inherited host policy
 * underneath to catch a miss.
 *
 * `X-Content-Type-Options: nosniff` because the body is model-generated and the content type is
 * asserted, not detected: without it Chromium may sniff a document whose bytes do not look like
 * HTML into some other type, and the type a document is interpreted as decides which CSP directive
 * governs it.
 *
 * `Cache-Control: no-store` because a slide document's id is minted per publish and dropped on
 * revoke; there is no version of it that is correct to serve twice, and a cached entry would keep a
 * revoked document reachable after the registry has forgotten it.
 */
export function slideResponseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': SLIDE_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  }
}

/**
 * A refusal. Deliberately shares no headers with the success path except the ones that describe the
 * refusal itself — in particular it carries no `Content-Security-Policy`, because there is no
 * author content in it to police, and it is `text/plain` so an error string can never be parsed as
 * markup.
 */
function refusal(status: number, body: string): SlideHttpResponse {
  return {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    body,
  }
}

export type SlideRequest = {
  url: string
  /** Absent in tests that do not care; a real `ProtocolRequest` always has one. */
  method?: string
}

/**
 * Resolve a `slide://` request against the registry.
 *
 * The accepted surface is as narrow as it can be made: `GET` only, the exact scheme, a host that is
 * a well-formed document id, and the single path `/`. Everything else is a 404 with no detail —
 * distinguishing "no such id" from "bad path" in the response would hand a slide a probe for its
 * siblings' ids, and there is no debugging value in it that a main-process log cannot serve better.
 */
export function resolveSlideRequest(
  registry: SlideRegistry,
  request: SlideRequest,
): SlideHttpResponse {
  const method = request.method ?? 'GET'
  if (method !== 'GET') {
    return refusal(405, 'method not allowed')
  }

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return refusal(400, 'bad request')
  }

  // An empty pathname is accepted alongside `/` because the two URL parsers involved disagree:
  // Chromium canonicalizes a `standard:` scheme URL to carry the trailing slash before
  // `protocol.handle` sees it, but Node's WHATWG `URL` treats `slide:` as non-special and leaves
  // `new URL('slide://<id>').pathname` empty. Unreachable in production, where `slideDocumentUrl`
  // always emits the slash — but a caller or test that writes the host-only form would otherwise
  // get a 404 that looks exactly like a registry miss.
  const path = url.pathname === '' ? SLIDE_DOCUMENT_PATH : url.pathname
  if (url.protocol !== `${SLIDE_SCHEME}:` || path !== SLIDE_DOCUMENT_PATH) {
    return refusal(404, 'not found')
  }

  const html = registry.get(url.hostname)
  if (html === undefined) {
    return refusal(404, 'not found')
  }

  return { status: 200, headers: slideResponseHeaders(), body: html }
}
