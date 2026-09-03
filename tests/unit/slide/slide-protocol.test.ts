import { describe, expect, it } from 'vitest'
import { DEFAULT_ARCHIVE_LIMITS } from '../../../src/main/document/store'
import {
  createSlideDocumentId,
  isPublishableSlideHtml,
  isSlideDocumentId,
  MAX_SLIDE_HTML_BYTES,
  SLIDE_CSP,
  SLIDE_DOCUMENT_ID_LENGTH,
  SLIDE_SCHEME,
  SLIDE_STAGE_HOST,
  SLIDE_THUMBNAIL_HOST,
  slideDocumentIdFromUrl,
  slideDocumentUrl,
} from '../../../src/shared/slide-protocol'

describe('slide document ids', () => {
  it('are 32 lowercase hex characters', () => {
    const id = createSlideDocumentId()
    expect(id).toHaveLength(SLIDE_DOCUMENT_ID_LENGTH)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(isSlideDocumentId(id)).toBe(true)
  })

  /**
   * The security claim, tested the only way a random-number property can be: at this sample size a
   * counter, a timestamp prefix (what `createSlideId` uses for slides) or a seeded PRNG reset per
   * call would all collide or share a prefix, and none of them does here.
   *
   * Guessability is what is actually at stake. Every slide is its own origin that can still
   * navigate, so a predictable id is a readable address for a sibling slide's document.
   */
  it('are unguessable: 2000 ids share no value and no common prefix', () => {
    const ids = Array.from({ length: 2000 }, () => createSlideDocumentId())
    expect(new Set(ids).size).toBe(2000)

    // Every leading hex nibble should appear across the sample; a timestamp or counter prefix
    // would pin the first characters to a handful of values.
    expect(new Set(ids.map((id) => id[0])).size).toBeGreaterThan(8)
  })

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(33)],
    ['uppercase hex', 'A'.repeat(32)],
    ['non-hex', 'g'.repeat(32)],
    ['a path traversal attempt', '../'.repeat(10) + 'ab'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isSlideDocumentId(value)).toBe(false)
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { toString: () => 'a'.repeat(32) }],
  ])('rejects %s without coercing it', (_label, value) => {
    expect(isSlideDocumentId(value)).toBe(false)
  })
})

describe('slide document urls', () => {
  /**
   * One host per *surface*, not per document (M8.2). Chromium groups sandboxed frames into renderer
   * processes by *site*, so a per-document host was a per-document process — 105 of them for a
   * 100-slide deck. The isolation between slides never came from the host (the frame is
   * opaque-origin from its sandbox), which `perf/cli/isolation-probe.ts` demonstrates in the real app.
   */
  it('put the stage host first and carry the id as the only path segment', () => {
    const id = createSlideDocumentId()
    const url = new URL(slideDocumentUrl(id))

    expect(url.protocol).toBe(`${SLIDE_SCHEME}:`)
    expect(url.hostname).toBe(SLIDE_STAGE_HOST)
    expect(url.pathname).toBe(`/${id}/`)
    expect(new URL(slideDocumentUrl(createSlideDocumentId())).hostname).toBe(url.hostname)
  })

  it('put thumbnails on their own host, so the rail gets its own renderer process', () => {
    const id = createSlideDocumentId()
    const url = new URL(slideDocumentUrl(id, SLIDE_THUMBNAIL_HOST))

    expect(url.hostname).toBe(SLIDE_THUMBNAIL_HOST)
    expect(url.hostname).not.toBe(SLIDE_STAGE_HOST)
    expect(url.pathname).toBe(`/${id}/`)
  })

  it.each([SLIDE_STAGE_HOST, SLIDE_THUMBNAIL_HOST] as const)(
    'round-trips an id back out of a %s url',
    (host) => {
      const id = createSlideDocumentId()
      expect(slideDocumentIdFromUrl(slideDocumentUrl(id, host))).toBe(id)
    },
  )

  it.each([
    ['a blob url', 'blob:http://localhost/abc'],
    ['an http url with the same shape', `http://${SLIDE_STAGE_HOST}/${'a'.repeat(32)}/`],
    ['a lookalike scheme', `slides://${SLIDE_STAGE_HOST}/${'a'.repeat(32)}/`],
    ['a malformed url', 'slide//nope'],
    ['the pre-M8.2 id-as-host form', `slide://${'a'.repeat(32)}/`],
    ['an unknown host', `slide://elsewhere/${'a'.repeat(32)}/`],
    ['a slide url with a bad id', `slide://${SLIDE_STAGE_HOST}/not-an-id/`],
    ['an id without its trailing slash', `slide://${SLIDE_STAGE_HOST}/${'a'.repeat(32)}`],
    ['a nested path under an id', `slide://${SLIDE_STAGE_HOST}/${'a'.repeat(32)}/index.html`],
    ['the host alone', `slide://${SLIDE_STAGE_HOST}/`],
  ])('refuses to extract an id from %s', (_label, url) => {
    expect(slideDocumentIdFromUrl(url)).toBeNull()
  })
})

describe('the publishable-html screen', () => {
  it('accepts a real slide document under the production limit', () => {
    expect(isPublishableSlideHtml('<html></html>')).toBe(true)
  })

  // The boundary, at an injected limit — the production one would need a 128 MB allocation to
  // cross, and a test that reached `false` by passing a non-string would prove only the type check.
  it('accepts exactly the limit and rejects one character more', () => {
    expect(isPublishableSlideHtml('a'.repeat(8), 8)).toBe(true)
    expect(isPublishableSlideHtml('a'.repeat(9), 8)).toBe(false)
  })

  it.each([
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['a length-carrying object', { length: 10 }],
    ['an array of chars', ['a', 'b']],
  ])('rejects %s', (_label, value) => {
    expect(isPublishableSlideHtml(value)).toBe(false)
  })

  /**
   * The limit is a ceiling on the same object the document model already bounds: a slide's HTML is
   * one `slides/<id>.html` member of the deck archive. If these drift, a document too large to be
   * opened becomes publishable through the renderer, which is the wrong way round.
   */
  it('matches the document model per-member ceiling', () => {
    expect(MAX_SLIDE_HTML_BYTES).toBe(DEFAULT_ARCHIVE_LIMITS.maxEntryBytes)
  })
})

describe('the slide CSP', () => {
  /**
   * `'unsafe-inline'` for script is the deliberate, load-bearing choice of this milestone — the
   * slide contract (§3.2 SL-I*) specifies a model-authored inline `<script>`, and a nonce would
   * require rewriting author bytes. This asserts it is present *and* that the directives which make
   * it safe are present too, so a future tightening cannot remove the containment while leaving the
   * permission.
   */
  it('permits inline script only inside a default-deny, no-network policy', () => {
    expect(SLIDE_CSP).toContain("script-src 'unsafe-inline'")
    expect(SLIDE_CSP).toContain("default-src 'none'")
    expect(SLIDE_CSP).toContain("connect-src 'none'")
    expect(SLIDE_CSP).toContain("object-src 'none'")
    expect(SLIDE_CSP).toContain("base-uri 'none'")
    expect(SLIDE_CSP).toContain("form-action 'none'")
    expect(SLIDE_CSP).toContain("frame-src 'none'")
  })

  it('never permits remote script, remote style or network access', () => {
    expect(SLIDE_CSP).not.toContain('http:')
    expect(SLIDE_CSP).not.toContain('https:')
    expect(SLIDE_CSP).not.toContain('*')
    expect(SLIDE_CSP).not.toContain("'unsafe-eval'")
  })
})
