import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'

/**
 * `install.ts` wiring, driven end to end with a mocked `electron`: the save dialog, the offscreen
 * print (a fake window returning a real single-page PDF), the pure orchestrator, the pdf-lib merge,
 * and the atomic write all run — only Chromium itself is replaced. This proves the produced file is a
 * real, correctly-paged PDF, and that a cancelled dialog and a malformed payload are handled.
 */

const mocks = vi.hoisted(() => {
  const instances: unknown[] = []
  const holder: { pdf: Uint8Array } = { pdf: Buffer.from('%PDF fake') }
  class FakeWindow {
    destroyed = false
    readonly webContents = {
      id: 700 + instances.length,
      setZoomFactor: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      executeJavaScript: vi.fn(async () => true),
      printToPDF: vi.fn(async () => holder.pdf),
    }
    constructor() {
      instances.push(this)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
    static fromWebContents(): null {
      return null
    }
  }
  return {
    FakeWindow,
    instances,
    holder,
    ipcHandle: vi.fn(),
    showSaveDialog: vi.fn(),
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  BrowserWindow: mocks.FakeWindow,
}))

const { installExportIpc, defaultPdfFileName } = await import('../../../src/main/export/install')
const { SlideRegistry } = await import('../../../src/main/slide/registry')
const { FILE_EXPORT_PDF_CHANNEL } = await import('../../../src/shared/ipc-contract')

type Handler = (event: { sender: unknown }, payload: unknown) => Promise<unknown>

function installedHandler(): Handler {
  installExportIpc(new SlideRegistry())
  const call = mocks.ipcHandle.mock.calls.find((c) => c[0] === FILE_EXPORT_PDF_CHANNEL)
  expect(call).toBeDefined()
  return call![1] as Handler
}

const dirs: string[] = []
async function tempPdfPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sloodge-export-ipc-'))
  dirs.push(dir)
  return join(dir, 'out.pdf')
}

async function realSinglePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([960, 540])
  return doc.save()
}

function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    slides: [
      { title: 'A', html: '<!doctype html><body>a' },
      { title: 'B', html: '<!doctype html><body>b' },
    ],
    currentIndex: 0,
    range: { kind: 'all' },
    deckTitle: 'Deck',
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  mocks.instances.length = 0
  mocks.holder.pdf = Buffer.from('%PDF fake')
  vi.clearAllMocks()
})

describe('installExportIpc', () => {
  it('rejects a malformed payload before any dialog or write', async () => {
    const handler = installedHandler()
    await expect(handler({ sender: {} }, { nope: true })).rejects.toThrow(/well-formed/)
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it('returns canceled and writes nothing when the save dialog is dismissed', async () => {
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined })
    const result = await handler({ sender: {} }, request())
    expect(result).toEqual({ canceled: true })
  })

  it('writes a real multi-page PDF at the chosen path and reports the page count', async () => {
    mocks.holder.pdf = await realSinglePagePdf()
    const outPath = await tempPdfPath()
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outPath })

    const result = (await handler({ sender: {} }, request())) as {
      canceled: false
      report: { pageCount: number; slideCount: number; outPath: string }
    }

    expect(result.canceled).toBe(false)
    expect(result.report.slideCount).toBe(2)
    expect(result.report.pageCount).toBe(2)
    expect(result.report.outPath).toBe(outPath)

    // The file is genuinely on disk and genuinely a 2-page PDF.
    const written = await readFile(outPath)
    const reloaded = await PDFDocument.load(written)
    expect(reloaded.getPageCount()).toBe(2)

    // No staging file left behind.
    const dir = join(outPath, '..')
    expect((await readdir(dir)).some((n) => n.endsWith('.partial'))).toBe(false)
  })

  it('respects a sub-range: a 1-slide range yields a 1-page PDF', async () => {
    mocks.holder.pdf = await realSinglePagePdf()
    const outPath = await tempPdfPath()
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outPath })

    const result = (await handler(
      { sender: {} },
      request({ range: { kind: 'range', from: 2, to: 2 } }),
    )) as { canceled: false; report: { pageCount: number } }

    expect(result.report.pageCount).toBe(1)
    const reloaded = await PDFDocument.load(await readFile(outPath))
    expect(reloaded.getPageCount()).toBe(1)
  })
})

describe('defaultPdfFileName', () => {
  it('slugs the deck title and appends .pdf', () => {
    expect(defaultPdfFileName('Q3 Review')).toBe('Q3-Review.pdf')
  })

  it('strips filesystem-hostile characters', () => {
    expect(defaultPdfFileName('a/b:c*?"<>|')).toBe('abc.pdf')
  })

  it('falls back to deck.pdf for an empty/blank title', () => {
    expect(defaultPdfFileName('   ')).toBe('deck.pdf')
    expect(defaultPdfFileName('***')).toBe('deck.pdf')
  })
})
