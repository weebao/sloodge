/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blobSlideUrls } from '../../../src/renderer/src/features/canvas/blobSlideUrls'
import {
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

describe('blobSlideUrls', () => {
  // The DOM implementation is one line each, so this pins the wiring — that it goes through the
  // real object-URL API with an HTML mime type — rather than any browser behaviour happy-dom
  // cannot model.
  it('creates a text/html blob url and revokes it through the URL API', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:spy/0')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)

    expect(blobSlideUrls.create('<html>hi</html>')).toBe('blob:spy/0')
    const blob = create.mock.calls[0]?.[0] as Blob
    expect(blob.type).toBe('text/html')
    expect(blob.size).toBeGreaterThan(0)

    blobSlideUrls.revoke('blob:spy/0')
    expect(revoke).toHaveBeenCalledWith('blob:spy/0')

    create.mockRestore()
    revoke.mockRestore()
  })
})

/**
 * The `slide://` transport's `create` is asynchronous, and that changes the shapes the lifecycle
 * has to survive: a publish can resolve after the frame has already moved on, and a publish can be
 * refused outright. Both are release-correctness questions — an id that resolves into a void is a
 * document stranded in the *main process's* registry, which no browser GC will ever reclaim.
 */
function asyncStubUrls(): SlideUrlFactory & {
  created: string[]
  revoked: string[]
  settle: (index: number) => void
  reject: (index: number) => void
} {
  const created: string[] = []
  const revoked: string[] = []
  const gates: { resolve: (url: string) => void; reject: (error: Error) => void }[] = []
  return {
    created,
    revoked,
    create: async (html) => {
      const index = created.length
      created.push(html)
      return new Promise<string>((resolve, reject) => {
        gates.push({ resolve: () => resolve(`slide://id${String(index)}/`), reject })
      })
    },
    revoke: (url) => {
      revoked.push(url)
    },
    settle: (index) => gates[index]?.resolve(''),
    reject: (index) => gates[index]?.reject(new Error('refused')),
  }
}

/** Lets queued microtasks (the `then` on a settled publish) run inside React's act scope. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useSlideUrl with an asynchronous transport', () => {
  it('shows nothing until the publish resolves, then the published url', async () => {
    const urls = asyncStubUrls()
    const { container } = render(<Probe html="<html><head>a" urls={urls} />)

    expect(urlOf(container)).toBe('')
    urls.settle(0)
    await flush()

    expect(urlOf(container)).toBe('slide://id0/')
  })

  // The ordering that only an async transport can produce: cleanup runs first, so it has no url to
  // release yet. If `settle` did not release it, the document would sit in main's registry forever
  // — a cross-process leak that no test of the blob path could ever have caught.
  it('releases a url that arrives after the component unmounted', async () => {
    const urls = asyncStubUrls()
    const { unmount } = render(<Probe html="<html><head>a" urls={urls} />)

    unmount()
    expect(urls.revoked).toEqual([])

    urls.settle(0)
    await flush()

    expect(urls.revoked).toEqual(['slide://id0/'])
  })

  it('releases a url that arrives after the html already changed', async () => {
    const urls = asyncStubUrls()
    const { container, rerender } = render(<Probe html="<html><head>a" urls={urls} />)

    rerender(<Probe html="<html><head>b" urls={urls} />)
    // The second publish lands first; the first is superseded and must not overwrite it.
    urls.settle(1)
    await flush()
    urls.settle(0)
    await flush()

    expect(urlOf(container)).toBe('slide://id1/')
    expect(urls.revoked).toEqual(['slide://id0/'])
  })

  it('leaks nothing across a run of edits followed by unmount', async () => {
    const urls = asyncStubUrls()
    const { rerender, unmount } = render(<Probe html="<html><head>0" urls={urls} />)
    for (const step of [1, 2, 3, 4]) {
      rerender(<Probe html={`<html><head>${String(step)}`} urls={urls} />)
    }
    unmount()
    for (const index of [0, 1, 2, 3, 4]) {
      urls.settle(index)
    }
    await flush()

    expect(urls.created).toHaveLength(5)
    expect(urls.revoked).toHaveLength(5)
    expect(new Set(urls.revoked).size).toBe(5)
  })

  // A refused publish (oversize, or a full registry) must not reject into nowhere and must not
  // release a url that was never created.
  it('keeps the previous document and releases nothing when a publish is refused', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const urls = asyncStubUrls()
    const { container, rerender } = render(<Probe html="<html><head>a" urls={urls} />)
    urls.settle(0)
    await flush()

    rerender(<Probe html="<html><head>b" urls={urls} />)
    urls.reject(1)
    await flush()

    // The first url was released by the effect cleanup, and its document stays painted; the second
    // never existed, so nothing else was released.
    expect(urlOf(container)).toBe('slide://id0/')
    expect(urls.revoked).toEqual(['slide://id0/'])

    // The rejection is the *only* signal a failed delivery produces — the frame just stays on its
    // old document with no error state in the UI — so swallowing it silently would make a filled
    // registry (i.e. a leak in main) and a genuinely oversized slide equally undiagnosable.
    expect(logged).toHaveBeenCalledOnce()
    logged.mockRestore()
  })
})
