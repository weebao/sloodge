import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `electron-renderer.ts` is the export module that touches `electron` at module scope, so — like
 * `slide/protocol.ts` — it is unreachable without `vi.mock('electron')`. The properties worth pinning
 * here are the security-relevant ones: the window's locked `webPreferences`, that the slide is loaded
 * over `slide://` (the same secure delivery as the canvas, never a weaker path), that the locked
 * print options are used, and that every published document is revoked whether the print succeeds or
 * throws.
 */

const mocks = vi.hoisted(() => {
  const instances: FakeWindow[] = []
  class FakeWindow {
    static readonly instances: FakeWindow[] = instances
    readonly options: unknown
    destroyed = false
    readonly webContents = {
      id: 500 + instances.length,
      setZoomFactor: vi.fn((_factor: number): void => undefined),
      loadURL: vi.fn((_url: string): Promise<void> => Promise.resolve()),
      executeJavaScript: vi.fn((_code: string, _userGesture?: boolean): Promise<unknown> =>
        Promise.resolve(true),
      ),
      printToPDF: vi.fn((_options: unknown): Promise<Buffer> =>
        Promise.resolve(Buffer.from('%PDF-1.7 fake')),
      ),
    }
    constructor(options: unknown) {
      this.options = options
      instances.push(this)
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

const { createOffscreenPdfRenderer } = await import('../../../src/main/export/electron-renderer')
const { SlideRegistry } = await import('../../../src/main/slide/registry')
const { slideDocumentUrl, isSlideDocumentId } = await import('../../../src/shared/slide-protocol')

afterEach(() => {
  mocks.instances.length = 0
  vi.clearAllMocks()
})

describe('createOffscreenPdfRenderer', () => {
  it('creates one locked-down hidden window and reuses it across renders', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    await renderer.renderToPdf('<!doctype html><body>a', 0)
    await renderer.renderToPdf('<!doctype html><body>b', 0)

    expect(mocks.instances).toHaveLength(1)
    const options = mocks.instances[0]!.options as {
      show: boolean
      useContentSize: boolean
      webPreferences: Record<string, unknown>
    }
    expect(options.show).toBe(false)
    expect(options.useContentSize).toBe(true)
    expect(options.webPreferences).toMatchObject({
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    })
    // No preload is exposed to the export window — the slide reaches neither app nor bridge.
    expect(options.webPreferences['preload']).toBeUndefined()
    renderer.dispose()
  })

  it('serves the slide over slide:// and prints with the locked options', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    const bytes = await renderer.renderToPdf('<!doctype html><body>hi', 0)

    const win = mocks.instances[0]!
    const loadedUrl = win.webContents.loadURL.mock.calls[0]?.[0] as string
    expect(loadedUrl.startsWith('slide://')).toBe(true)
    const id = new URL(loadedUrl).hostname
    expect(isSlideDocumentId(id)).toBe(true)
    expect(loadedUrl).toBe(slideDocumentUrl(id))

    // The readiness barrier ran before printing.
    expect(win.webContents.executeJavaScript).toHaveBeenCalledOnce()

    const printOptions = win.webContents.printToPDF.mock.calls[0]?.[0] as {
      printBackground: boolean
      margins: Record<string, number>
    }
    expect(printOptions.printBackground).toBe(true)
    expect(printOptions.margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })

    expect(bytes).toBeInstanceOf(Uint8Array)
    renderer.dispose()
  })

  it('revokes the published document after a successful print (peak memory = one slide)', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    await renderer.renderToPdf('<!doctype html><body>x', 0)
    expect(registry.size).toBe(0)
    renderer.dispose()
  })

  it('revokes the published document even when printToPDF throws', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    // First render creates the window and succeeds; then make the next print fail.
    await renderer.renderToPdf('<!doctype html><body>x', 0)
    mocks.instances[0]!.webContents.printToPDF.mockRejectedValueOnce(new Error('print failed'))
    await expect(renderer.renderToPdf('<!doctype html><body>y', 0)).rejects.toThrow('print failed')
    // The failed slide's document is still released — no leak on the error path.
    expect(registry.size).toBe(0)
    renderer.dispose()
  })

  it('rejects (does not print) when the registry refuses the publish', async () => {
    const registry = new SlideRegistry({ limits: { maxDocuments: 0 } })
    const renderer = createOffscreenPdfRenderer(registry)
    await expect(renderer.renderToPdf('<!doctype html><body>x', 0)).rejects.toThrow(
      /could not publish/,
    )
    // A window may have been created, but nothing was printed.
    if (mocks.instances[0]) {
      expect(mocks.instances[0].webContents.printToPDF).not.toHaveBeenCalled()
    }
    renderer.dispose()
  })

  it('dispose destroys the window and releases anything it still owned', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    await renderer.renderToPdf('<!doctype html><body>x', 0)
    renderer.dispose()
    expect(mocks.instances[0]!.destroyed).toBe(true)
    // Idempotent.
    renderer.dispose()
  })
})
