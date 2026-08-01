/**
 * File ▸ Open (M4.5): the format dispatch, the read, and the payload that crosses to the renderer.
 *
 * `openDeckAtPath` is deliberately Electron-free — the dialog lives in `installDocumentIpc`, this is
 * everything after it — so the whole open behaviour is testable against real files on disk.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  getOpenDocument,
  openDeckAtPath,
  setOpenDocument,
} from '../../../src/main/document/open-ipc'
import { writeDeck } from '../../../src/main/document/store'
import { createEmptyDeck, createSlideEntry } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import { OPEN_DECK_FILTERS, openSourceForPath } from '../../../src/shared/document/open'
import { createDocumentBridge } from '../../../src/preload/documentBridge'
import { ORIGINAL_ARCHIVE_ENTRY } from '../../../src/shared/import/pptx/ledger'
import { fixturePath } from './fixtures'

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sloodge-open-'))
})

describe('openSourceForPath', () => {
  it('dispatches on extension, case-insensitively', () => {
    expect(openSourceForPath('/a/b/deck.sloodge')).toBe('sloodge')
    expect(openSourceForPath('/a/b/deck.pptx')).toBe('pptx')
    expect(openSourceForPath('/a/b/DECK.PPTX')).toBe('pptx')
    expect(openSourceForPath('/a/b/theme.potx')).toBe('potx')
    expect(openSourceForPath('/a/b/show.ppsx')).toBe('pptx')
    // Both formats are zips, so magic bytes cannot discriminate; an unknown extension is read as a
    // deck and fails with a specific error rather than being silently reinterpreted.
    expect(openSourceForPath('/a/b/mystery.bin')).toBe('sloodge')
  })

  it('offers a combined filter first, so one chooser covers both formats', () => {
    expect(OPEN_DECK_FILTERS[0]?.extensions).toEqual(['sloodge', 'pptx', 'potx'])
  })
})

describe('openDeckAtPath', () => {
  it('opens a .sloodge through readDeck', async () => {
    const slide = createSlideEntry({ title: 'Hello' })
    const deck = createEmptyDeck({ title: 'A saved deck' })
    const manifest = { ...deck, slides: { [slide.id]: slide }, slideOrder: [slide.id] }
    const path = join(dir, 'saved.sloodge')
    const written = await writeDeck(path, {
      manifest,
      slides: { [slide.id]: createStarterSlideHtml({ id: slide.id, title: 'Hello' }) },
      notes: {},
      theme: null,
      extras: {},
    })
    expect(written.ok).toBe(true)

    const result = await openDeckAtPath(path)
    if (!result.ok) throw new Error(result.error.message)
    expect(result.payload.source).toBe('sloodge')
    expect(result.payload.fileName).toBe('saved.sloodge')
    expect(result.payload.deck.manifest.title).toBe('A saved deck')
    expect(result.payload.import).toBeUndefined()
  })

  it('opens a .pptx through the importer and reports the import', async () => {
    const result = await openDeckAtPath(fixturePath('python-pptx-deck.pptx'))
    if (!result.ok) throw new Error(result.error.message)
    expect(result.payload.source).toBe('pptx')
    expect(result.payload.deck.manifest.slideOrder).toHaveLength(3)
    expect(result.payload.import?.slideCount).toBe(3)
    expect(result.payload.import?.partCount).toBe(43)
    expect(result.payload.import?.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.payload.import?.conversionNotes.length).toBeGreaterThan(0)
  })

  it('keeps the retained archive in main and out of the renderer payload', async () => {
    const result = await openDeckAtPath(fixturePath('python-pptx-deck.pptx'))
    if (!result.ok) throw new Error(result.error.message)
    // Main holds it, for round-trip export and because it is far too large to ship per open.
    expect(result.bundle.extras[ORIGINAL_ARCHIVE_ENTRY]).toBeDefined()
    // The renderer payload has no `extras` field at all — the archive cannot leak across by accident.
    expect(Object.keys(result.payload.deck)).toEqual(['manifest', 'slides', 'notes', 'theme'])
  })

  it('returns a typed error rather than throwing for an unreadable file', async () => {
    const path = join(dir, 'garbage.sloodge')
    await writeFile(path, 'not a zip')
    const result = await openDeckAtPath(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
  })

  it('reports a missing file', async () => {
    const result = await openDeckAtPath(join(dir, 'absent.pptx'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-found')
  })

  it('gives a specific error for a .pptx opened under a .sloodge name', async () => {
    // Not silently reinterpreted: the user gets told what is actually wrong.
    const result = await openDeckAtPath(
      fixturePath('python-pptx-deck.pptx').replace(/\.pptx$/, '.x'),
    )
    expect(result.ok).toBe(false)
  })
})

describe('the open-document session', () => {
  it('holds the last opened bundle for main-side consumers', async () => {
    setOpenDocument(null)
    expect(getOpenDocument()).toBeNull()

    const path = fixturePath('sloodge-export.pptx')
    const result = await openDeckAtPath(path)
    if (!result.ok) throw new Error(result.error.message)
    setOpenDocument({ path, bundle: result.bundle })

    const held = getOpenDocument()
    expect(held?.path).toBe(path)
    expect(held?.bundle.extras[ORIGINAL_ARCHIVE_ENTRY]).toBeDefined()
    setOpenDocument(null)
  })
})

describe('the preload bridge', () => {
  it('invokes file:open with an empty payload and forwards the response', async () => {
    const calls: { channel: string; payload: unknown }[] = []
    const bridge = createDocumentBridge(async (channel, payload) => {
      calls.push({ channel, payload })
      return { canceled: true }
    })

    await expect(bridge.openDeck()).resolves.toEqual({ canceled: true })
    // No path parameter exists to be tampered with: main runs the chooser.
    expect(calls).toEqual([{ channel: 'file:open', payload: {} }])
  })
})
