/**
 * @vitest-environment happy-dom
 */
import { cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  domSlideUrls,
  useSlideUrl,
  type SlideUrlFactory,
} from '../../../src/renderer/src/features/canvas/useSlideUrl'
import { SLIDE_CSP } from '../../../src/renderer/src/features/canvas/wrapSlideHtml'

afterEach(() => {
  cleanup()
})

/**
 * A stub blob store. happy-dom's `URL.createObjectURL` is not a real browser blob store, so the
 * only way to *prove* the revoke half of the lifecycle is to hand the hook a factory that records
 * what it was asked to create and revoke.
 */
function stubUrls(): SlideUrlFactory & {
  created: string[]
  revoked: string[]
  live: () => string[]
} {
  const created: string[] = []
  const revoked: string[] = []
  return {
    created,
    revoked,
    create: (html) => {
      const url = `blob:stub/${String(created.length)}`
      created.push(html)
      return url
    },
    revoke: (url) => {
      revoked.push(url)
    },
    live: () =>
      created
        .map((_, index) => `blob:stub/${String(index)}`)
        .filter((url) => !revoked.includes(url)),
  }
}

function Probe({ html, urls }: { html: string; urls: SlideUrlFactory }): JSX.Element {
  const url = useSlideUrl(html, urls)
  return <span data-testid="url">{url ?? ''}</span>
}

function urlOf(container: HTMLElement): string {
  return container.querySelector('[data-testid="url"]')?.textContent ?? ''
}

describe('useSlideUrl', () => {
  it('hands back a url built from the CSP-wrapped document, not the raw html', () => {
    const urls = stubUrls()
    const { container } = render(<Probe html="<html><head><title>t</title></head>" urls={urls} />)

    expect(urlOf(container)).toBe('blob:stub/0')
    expect(urls.created).toHaveLength(1)
    expect(urls.created[0]).toContain(SLIDE_CSP)
    expect(urls.created[0]).toContain('<title>t</title>')
  })

  it('keeps the same url across re-renders that do not change the html', () => {
    const urls = stubUrls()
    const { container, rerender } = render(<Probe html="<html><head>a" urls={urls} />)

    rerender(<Probe html="<html><head>a" urls={urls} />)
    rerender(<Probe html="<html><head>a" urls={urls} />)

    expect(urlOf(container)).toBe('blob:stub/0')
    // The load-bearing assertion: one document, created once, never reloaded.
    expect(urls.created).toHaveLength(1)
    expect(urls.revoked).toEqual([])
  })

  it('revokes the previous url when the html changes', () => {
    const urls = stubUrls()
    const { container, rerender } = render(<Probe html="<html><head>a" urls={urls} />)

    rerender(<Probe html="<html><head>b" urls={urls} />)

    expect(urlOf(container)).toBe('blob:stub/1')
    expect(urls.revoked).toEqual(['blob:stub/0'])
    expect(urls.live()).toEqual(['blob:stub/1'])
  })

  it('revokes on unmount, leaving nothing live', () => {
    const urls = stubUrls()
    const { unmount } = render(<Probe html="<html><head>a" urls={urls} />)

    unmount()

    expect(urls.revoked).toEqual(['blob:stub/0'])
    expect(urls.live()).toEqual([])
  })

  // A blob URL is a document-lifetime resource: every one that is created and not revoked is a
  // leaked document held alive for the life of the window.
  it('leaks nothing across a run of edits followed by unmount', () => {
    const urls = stubUrls()
    const { rerender, unmount } = render(<Probe html="<html><head>0" urls={urls} />)

    for (const step of [1, 2, 3, 4]) {
      rerender(<Probe html={`<html><head>${String(step)}`} urls={urls} />)
    }
    unmount()

    expect(urls.created).toHaveLength(5)
    expect(urls.revoked).toHaveLength(5)
    expect(urls.live()).toEqual([])
  })

  it('revokes exactly once per url', () => {
    const urls = stubUrls()
    const { rerender, unmount } = render(<Probe html="<html><head>a" urls={urls} />)
    rerender(<Probe html="<html><head>b" urls={urls} />)
    unmount()

    expect(new Set(urls.revoked).size).toBe(urls.revoked.length)
  })
})

describe('domSlideUrls', () => {
  // The DOM implementation is one line each, so this pins the wiring — that it goes through the
  // real object-URL API with an HTML mime type — rather than any browser behaviour happy-dom
  // cannot model.
  it('creates a text/html blob url and revokes it through the URL API', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:spy/0')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)

    expect(domSlideUrls.create('<html>hi</html>')).toBe('blob:spy/0')
    const blob = create.mock.calls[0]?.[0] as Blob
    expect(blob.type).toBe('text/html')
    expect(blob.size).toBeGreaterThan(0)

    domSlideUrls.revoke('blob:spy/0')
    expect(revoke).toHaveBeenCalledWith('blob:spy/0')

    create.mockRestore()
    revoke.mockRestore()
  })
})
