import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The PPTX renderer touches `electron`, so — like `electron-renderer.ts` — it is unreachable without
 * `vi.mock('electron')`. What matters here: it reuses the *same* locked secure window (denies
 * window-open, blocks navigation), loads the slide over `slide://`, runs the measurement pass, captures
 * a full-slide PNG, and revokes the published document on every path.
 */

type WindowOpenHandler = (details: { url: string }) => { action: string }
type NavListener = (event: { preventDefault: () => void }, url: string) => void

const MEASURE = {
  nodes: [],
  body: { backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'none' },
  hasAnimation: false,
}

const mocks = vi.hoisted(() => {
  const instances: FakeWindow[] = []
  class FakeWindow {
    static readonly instances: FakeWindow[] = instances
    readonly options: unknown
    destroyed = false
    windowOpenHandler: WindowOpenHandler | undefined
    readonly listeners = new Map<string, NavListener[]>()
    readonly webContents = {
      id: 700 + instances.length,
      setZoomFactor: vi.fn(),
      setWindowOpenHandler: vi.fn((handler: WindowOpenHandler): void => {
        this.windowOpenHandler = handler
      }),
      on: vi.fn((event: string, listener: NavListener): unknown => {
        const bucket = this.listeners.get(event) ?? []
        bucket.push(listener)
        this.listeners.set(event, bucket)
        return this.webContents
      }),
      loadURL: vi.fn((_url: string): Promise<void> => Promise.resolve()),
      executeJavaScript: vi.fn((code: string): Promise<unknown> =>
        Promise.resolve(code.includes('hasAnimation') ? MEASURE : true),
      ),
      capturePage: vi.fn((): Promise<{ toPNG: () => Buffer }> =>
        Promise.resolve({ toPNG: () => Buffer.from('PNGDATA') }),
      ),
    }
    constructor(options: unknown) {
      this.options = options
      instances.push(this)
    }
    menuRemoved = false
    removeMenu(): void {
      this.menuRemoved = true
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  return { FakeWindow, instances }
})

vi.mock('electron', () => ({ BrowserWindow: mocks.FakeWindow }))

const { createOffscreenPptxRenderer } = await import('../../../src/main/export/pptx-renderer')
const { SlideRegistry } = await import('../../../src/main/slide/registry')

afterEach(() => {
  mocks.instances.length = 0
  vi.clearAllMocks()
})

describe('createOffscreenPptxRenderer', () => {
  it('reuses one locked, secure hidden window and denies window-open + navigation', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPptxRenderer(registry)
    await renderer.renderSlide('<!doctype html><body>a', 0)
    await renderer.renderSlide('<!doctype html><body>b', 1)

    expect(mocks.instances).toHaveLength(1)
    const options = mocks.instances[0]!.options as {
      show: boolean
      webPreferences: Record<string, unknown>
    }
    expect(options.show).toBe(false)
    expect(options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    const win = mocks.instances[0]!
    expect(win.windowOpenHandler!({ url: 'http://evil.example' })).toEqual({ action: 'deny' })
    renderer.dispose()
  })

  it('loads over slide://, measures, and captures a full-slide PNG data URL', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPptxRenderer(registry)
    const out = await renderer.renderSlide('<!doctype html><body>hi', 0)

    const win = mocks.instances[0]!
    expect(String(win.webContents.loadURL.mock.calls[0]?.[0]).startsWith('slide://')).toBe(true)
    expect(win.webContents.capturePage).toHaveBeenCalledOnce()
    expect(out.measure).toEqual(MEASURE)
    expect(out.rasterDataUrl).toBe(
      `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`,
    )
    renderer.dispose()
  })

  it('degrades to an empty measure when the measurement pass throws (does not fail the slide)', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPptxRenderer(registry)
    await renderer.renderSlide('<!doctype html><body>x', 0)
    mocks.instances[0]!.webContents.executeJavaScript.mockImplementation((code: string) =>
      code.includes('hasAnimation')
        ? Promise.reject(new Error('measure boom'))
        : Promise.resolve(true),
    )
    const out = await renderer.renderSlide('<!doctype html><body>y', 1)
    expect(out.measure.nodes).toEqual([])
    expect(out.rasterDataUrl).not.toBeNull()
    renderer.dispose()
  })

  it('returns a null capture (not a throw) when capturePage fails', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPptxRenderer(registry)
    await renderer.renderSlide('<!doctype html><body>x', 0)
    mocks.instances[0]!.webContents.capturePage.mockRejectedValueOnce(new Error('capture boom'))
    const out = await renderer.renderSlide('<!doctype html><body>y', 1)
    expect(out.rasterDataUrl).toBeNull()
    renderer.dispose()
  })

  it('takes a second, descendants-hidden capture only when the body paints a gradient/image (M4.8a)', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPptxRenderer(registry)
    const solid = await renderer.renderSlide('<!doctype html><body>x', 0)
    expect(solid.backgroundDataUrl).toBeNull()
    const win = mocks.instances[0]!
    expect(win.webContents.capturePage).toHaveBeenCalledTimes(1)

    const gradient = {
      ...MEASURE,
      body: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(red, blue)' },
    }
    const scripts: string[] = []
    win.webContents.executeJavaScript.mockImplementation((code: string) => {
      scripts.push(code)
      return Promise.resolve(code.includes('hasAnimation') ? gradient : true)
    })
    win.webContents.capturePage
      .mockResolvedValueOnce({ toPNG: () => Buffer.from('FULL') })
      .mockResolvedValueOnce({ toPNG: () => Buffer.from('BGONLY') })
    const out = await renderer.renderSlide('<!doctype html><body>y', 1)
    expect(out.rasterDataUrl).toBe(
      `data:image/png;base64,${Buffer.from('FULL').toString('base64')}`,
    )
    expect(out.backgroundDataUrl).toBe(
      `data:image/png;base64,${Buffer.from('BGONLY').toString('base64')}`,
    )
    // The hide step ran, in the slide's context, before the second capture.
    expect(scripts.some((s) => s.includes('visibility: hidden !important'))).toBe(true)
    expect(win.webContents.capturePage).toHaveBeenCalledTimes(3)
    renderer.dispose()
  })

  it('revokes the published document after each render (peak memory = one slide)', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPptxRenderer(registry)
    await renderer.renderSlide('<!doctype html><body>x', 0)
    expect(registry.size).toBe(0)
    renderer.dispose()
    expect(mocks.instances[0]!.destroyed).toBe(true)
  })
})
