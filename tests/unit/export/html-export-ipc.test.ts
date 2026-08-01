/**
 * `install.ts`'s HTML channel (M4.4), driven end to end with a mocked `electron`: the save dialog,
 * the pure bundle build, the fflate zip and the atomic write all really run — only the dialog and
 * `ipcMain` are replaced. The assertion is made against the **file on disk**, unzipped, so this
 * proves a user who runs File ▸ Export ▸ HTML gets a real, complete, openable bundle.
 *
 * Note what this handler does *not* need, unlike the PDF one: no offscreen window, no `slide://`
 * registry, no Chromium. The slides are already the output.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'

const mocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  showSaveDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  BrowserWindow: { fromWebContents: () => null },
}))

const { installExportIpc } = await import('../../../src/main/export/install')
const { SlideRegistry } = await import('../../../src/main/slide/registry')
const { FILE_EXPORT_HTML_CHANNEL } = await import('../../../src/shared/ipc-contract')

type Handler = (event: { sender: unknown }, payload: unknown) => Promise<unknown>

function installedHandler(): Handler {
  installExportIpc(new SlideRegistry())
  const call = mocks.ipcHandle.mock.calls.find((c) => c[0] === FILE_EXPORT_HTML_CHANNEL)
  expect(call).toBeDefined()
  return call![1] as Handler
}

const dirs: string[] = []
async function tempZipPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sloodge-html-export-'))
  dirs.push(dir)
  return join(dir, 'out.zip')
}

function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    slides: [
      { id: 's_a', title: 'A', html: '<!doctype html><title>A</title><body>a' },
      { id: 's_b', title: 'B', html: '<!doctype html><title>B</title><body>b' },
    ],
    currentIndex: 0,
    range: { kind: 'all' },
    deckTitle: 'Deck',
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.clearAllMocks()
})

describe('installExportIpc — HTML channel', () => {
  it('registers the HTML channel alongside the PDF one', () => {
    installedHandler()
    const channels = mocks.ipcHandle.mock.calls.map((call) => call[0])
    expect(channels).toContain(FILE_EXPORT_HTML_CHANNEL)
  })

  it('rejects a malformed payload before any dialog or write', async () => {
    const handler = installedHandler()
    await expect(handler({ sender: {} }, { nope: true })).rejects.toThrow(/well-formed/)
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it('returns canceled and writes nothing when the save dialog is dismissed', async () => {
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined })
    expect(await handler({ sender: {} }, request())).toEqual({ canceled: true })
  })

  it('treats an empty filePath as a cancel, and writes nothing', async () => {
    // `showSaveDialog` can resolve `canceled: false` with an empty path. Without the empty-string
    // check in `chooseSavePath` that becomes an export written to `''` — and since M4.4 folded the
    // PDF, PPTX and HTML handlers onto that one helper, this guard now protects all three formats.
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '' })
    expect(await handler({ sender: {} }, request())).toEqual({ canceled: true })
  })

  it('treats an undefined filePath as a cancel', async () => {
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: undefined })
    expect(await handler({ sender: {} }, request())).toEqual({ canceled: true })
  })

  it('defaults the save dialog to a .zip named for the deck', async () => {
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined })
    await handler({ sender: {} }, request({ deckTitle: 'Q3 Review' }))
    expect(mocks.showSaveDialog.mock.calls[0]![0]).toMatchObject({
      defaultPath: 'Q3-Review.zip',
    })
  })

  it('writes a real zip at the chosen path containing the shell and every slide', async () => {
    const outPath = await tempZipPath()
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outPath })

    const result = (await handler({ sender: {} }, request())) as {
      canceled: false
      report: { slideCount: number; fileCount: number; outPath: string; format: string }
    }

    expect(result.canceled).toBe(false)
    expect(result.report.format).toBe('html')
    expect(result.report.slideCount).toBe(2)
    expect(result.report.fileCount).toBe(4)
    expect(result.report.outPath).toBe(outPath)

    // The file is genuinely on disk and genuinely a zip with the expected members.
    const entries = Object.keys(unzipSync(await readFile(outPath))).toSorted()
    expect(entries).toEqual([
      'Deck/deck.json',
      'Deck/index.html',
      'Deck/slides/001-a.html',
      'Deck/slides/002-b.html',
    ])

    // No staging file left behind.
    const dir = join(outPath, '..')
    expect((await readdir(dir)).some((name) => name.endsWith('.partial'))).toBe(false)
  })

  it('respects a sub-range', async () => {
    const outPath = await tempZipPath()
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outPath })

    const result = (await handler(
      { sender: {} },
      request({ range: { kind: 'range', from: 2, to: 2 } }),
    )) as { canceled: false; report: { slideCount: number } }

    expect(result.report.slideCount).toBe(1)
    const entries = Object.keys(unzipSync(await readFile(outPath)))
    expect(entries.filter((path) => path.includes('/slides/'))).toEqual(['Deck/slides/001-b.html'])
  })

  it('writes no file at all when the range is empty', async () => {
    const outPath = await tempZipPath()
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outPath })

    const result = (await handler(
      { sender: {} },
      request({ range: { kind: 'range', from: 50, to: 60 } }),
    )) as { canceled: false; report: { fileCount: number } }

    expect(result.report.fileCount).toBe(0)
    // Never a truncated or empty archive at the user's chosen path.
    await expect(readFile(outPath)).rejects.toThrow()
  })

  it('ships the slide bytes it was handed, verbatim', async () => {
    const outPath = await tempZipPath()
    const handler = installedHandler()
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outPath })
    const payload = request()
    await handler({ sender: {} }, payload)

    const out = unzipSync(await readFile(outPath))
    const expected = (payload as { slides: { html: string }[] }).slides[0]!.html
    expect(new TextDecoder().decode(out['Deck/slides/001-a.html'])).toBe(expected)
  })
})
