import { describe, expect, it, vi } from 'vitest'
import {
  runCreateSlide,
  runReadSlide,
  runReorder,
  runScreenshot,
  runUpdateSlide,
  type HostErrorCode,
  type HostOutcome,
  type ResolvedSlide,
  type SlideToolHost,
} from '../../../src/shared/agent/slide-tools'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'

const ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA' as SlideId
const validHtml = createStarterSlideHtml({ id: ID, title: 'Hello' })

function ok<T>(value: T): HostOutcome<T> {
  return { ok: true, value }
}

function err<T>(code: HostErrorCode, message: string): HostOutcome<T> {
  return { ok: false, code, message }
}

function fakeHost(overrides: Partial<SlideToolHost> = {}): SlideToolHost {
  const resolved: ResolvedSlide = {
    id: ID,
    index: 1,
    title: 'Hello',
    notes: null,
    html: validHtml,
    capabilities: ['static'],
  }
  return {
    resolve: vi.fn(async () => resolved),
    list: vi.fn(async () => [{ id: ID, index: 1, title: 'Hello' }]),
    count: vi.fn(async () => 1),
    create: vi.fn(async () => ok({ slideId: ID, index: 1 })),
    update: vi.fn(async () => ok({ slideId: ID, index: 1, revision: 2 })),
    reorder: vi.fn(async () => ok({ order: [ID] })),
    screenshot: vi.fn(async () => ok({ pngBase64: 'UE5H' })),
    ...overrides,
  }
}

describe('runCreateSlide', () => {
  it('rejects malformed HTML before touching the host (contract gate)', async () => {
    const host = fakeHost()
    const result = await runCreateSlide(host, { html: '<div>no slide root</div>', title: 'X' })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(host.create).not.toHaveBeenCalled()
  })

  it('dispatches valid HTML and returns the new id/index', async () => {
    const host = fakeHost()
    const result = await runCreateSlide(host, { html: validHtml, title: 'Hello' })
    expect(result.isError).toBeUndefined()
    expect(host.create).toHaveBeenCalledOnce()
    expect(result.structuredContent).toEqual({ slideId: ID, index: 1 })
  })

  it('surfaces a host error as an actionable isError result', async () => {
    const host = fakeHost({
      create: vi.fn(async () =>
        err<{ slideId: string; index: number }>('index-out-of-range', 'position 9 is out of range'),
      ),
    })
    const result = await runCreateSlide(host, { html: validHtml, title: 'Hello', position: 9 })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('out of range')
  })
})

describe('runUpdateSlide', () => {
  it('requires at least one of html or notes', async () => {
    const host = fakeHost()
    const result = await runUpdateSlide(host, { slideId: ID })
    expect(result.isError).toBe(true)
    expect(host.update).not.toHaveBeenCalled()
  })

  it('rejects when the slide does not exist', async () => {
    const host = fakeHost({ resolve: vi.fn(async () => null) })
    const result = await runUpdateSlide(host, { slideId: ID, notes: 'x' })
    expect(result.isError).toBe(true)
    expect(host.update).not.toHaveBeenCalled()
  })

  it('validates new HTML against the slide existing capabilities', async () => {
    // Slide is "static"; new html has a script => SL-H01 rejects before dispatch.
    const scripted = validHtml.replace('</body>', '<script>var a=1;</script></body>')
    const host = fakeHost()
    const result = await runUpdateSlide(host, { slideId: ID, html: scripted })
    expect(result.isError).toBe(true)
    expect(host.update).not.toHaveBeenCalled()
  })

  it('applies a notes-only update', async () => {
    const host = fakeHost()
    const result = await runUpdateSlide(host, { slideId: ID, notes: 'speaker note' })
    expect(result.isError).toBeUndefined()
    expect(host.update).toHaveBeenCalledWith({ slideId: ID, notes: 'speaker note' })
    expect(result.structuredContent).toMatchObject({ revision: 2 })
  })
})

describe('runReadSlide', () => {
  it('requires a slideId or index', async () => {
    const result = await runReadSlide(fakeHost(), {})
    expect(result.isError).toBe(true)
  })

  it('reports the deck size when the slide is missing', async () => {
    const host = fakeHost({ resolve: vi.fn(async () => null), count: vi.fn(async () => 5) })
    const result = await runReadSlide(host, { index: 9 })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('5 slides')
  })

  it('returns HTML in both the text block and structuredContent', async () => {
    const result = await runReadSlide(fakeHost(), { slideId: ID })
    expect((result.content[0] as { text: string }).text).toBe(validHtml)
    expect(result.structuredContent).toMatchObject({ slideId: ID, index: 1, html: validHtml })
  })
})

describe('runReorder', () => {
  it('passes the order through on success', async () => {
    const result = await runReorder(fakeHost(), { slideId: ID, toPosition: 1 })
    expect(result.structuredContent).toEqual({ order: [ID] })
  })

  it('surfaces a bounds error from the host', async () => {
    const host = fakeHost({
      reorder: vi.fn(async () =>
        err<{ order: string[] }>('index-out-of-range', 'position 9 is out of range'),
      ),
    })
    const result = await runReorder(host, { slideId: ID, toPosition: 9 })
    expect(result.isError).toBe(true)
  })
})

describe('runScreenshot', () => {
  it('returns an image block with no structuredContent', async () => {
    const result = await runScreenshot(fakeHost(), { slideId: ID })
    expect(result.content[0]).toEqual({ type: 'image', data: 'UE5H', mimeType: 'image/png' })
    expect(result.structuredContent).toBeUndefined()
  })

  it('reports when rendering is unavailable', async () => {
    const host = fakeHost({
      screenshot: vi.fn(async () =>
        err<{ pngBase64: string }>('screenshot-unavailable', 'not available'),
      ),
    })
    const result = await runScreenshot(host, { slideId: ID })
    expect(result.isError).toBe(true)
  })
})
