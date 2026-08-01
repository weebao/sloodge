import { describe, expect, it, vi } from 'vitest'
import { createDeckToolHost } from '../../../src/main/agent/deck-host'
import { createLocalDeckEditor } from '../../../src/main/agent/deck-editor'
import { DocumentHistory } from '../../../src/shared/document/history'
import type { DeckDoc } from '../../../src/shared/document/commands'
import { slideCount, slidesInOrder } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'
import { makeDoc } from '../document/deck-doc-fixture'

function historyOf(count: number): DocumentHistory<DeckDoc> {
  return new DocumentHistory<DeckDoc>(makeDoc(count).doc)
}

const html = (title: string): string =>
  createStarterSlideHtml({ id: 's_01H8XQZ4P7K2M9NB3VYRTC6FDA' as SlideId, title })

describe('createDeckToolHost — create', () => {
  it('appends a slide through a command, and the edit is undoable', async () => {
    const history = historyOf(2)
    const onChange = vi.fn()
    const host = createDeckToolHost({ editor: createLocalDeckEditor(history), onChange })

    const before = slideCount(history.doc.manifest)
    const outcome = await host.create({ html: html('New'), title: 'New', capabilities: ['static'] })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.index).toBe(before + 1)
    expect(slideCount(history.doc.manifest)).toBe(before + 1)
    expect(onChange).toHaveBeenCalledOnce()
    // Tagged as an agent edit and undoable exactly like a manual one.
    expect(history.undoStack().at(-1)?.origin.kind).toBe('agent')
    expect(history.canUndo).toBe(true)

    const undone = history.undo()
    expect(undone.ok).toBe(true)
    expect(slideCount(history.doc.manifest)).toBe(before)
  })

  it('inserts at a 1-based position', async () => {
    const history = historyOf(2)
    const host = createDeckToolHost({ editor: createLocalDeckEditor(history) })
    const outcome = await host.create({
      html: html('Front'),
      title: 'Front',
      capabilities: ['static'],
      position: 1,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.index).toBe(1)
    expect((await host.resolve({ index: 1 }))?.title).toBe('Front')
  })

  it('rejects a position out of range', async () => {
    const host = createDeckToolHost({ editor: createLocalDeckEditor(historyOf(2)) })
    const outcome = await host.create({
      html: html('X'),
      title: 'X',
      capabilities: ['static'],
      position: 9,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('index-out-of-range')
  })
})

describe('createDeckToolHost — update', () => {
  it('replaces HTML and notes through commands, undoably', async () => {
    const { doc, ids } = makeDoc(1)
    const history = new DocumentHistory<DeckDoc>(doc)
    const host = createDeckToolHost({ editor: createLocalDeckEditor(history) })
    const id = ids[0]!
    const originalHtml = history.doc.slides[id]

    const outcome = await host.update({ slideId: id, html: html('Edited'), notes: 'note' })
    expect(outcome.ok).toBe(true)
    expect((await host.resolve({ slideId: id }))?.html).toBe(html('Edited'))
    expect((await host.resolve({ slideId: id }))?.notes).toBe('note')

    // html + notes were one apply → one undo entry restores both.
    history.undo()
    expect(history.doc.slides[id]).toBe(originalHtml)
  })

  it('rejects an unknown slide id', async () => {
    const host = createDeckToolHost({ editor: createLocalDeckEditor(historyOf(1)) })
    const outcome = await host.update({
      slideId: 's_00000000000000000000000000' as SlideId,
      html: html('x'),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('slide-not-found')
  })
})

describe('createDeckToolHost — reorder', () => {
  it('moves a slide and returns the new order, undoably', async () => {
    const { doc, ids } = makeDoc(3)
    const history = new DocumentHistory<DeckDoc>(doc)
    const host = createDeckToolHost({ editor: createLocalDeckEditor(history) })
    const first = ids[0]!

    const outcome = await host.reorder({ slideId: first, toPosition: 3 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.order.at(-1)).toBe(first)

    history.undo()
    expect(slidesInOrder(history.doc.manifest)[0]?.id).toBe(first)
  })

  it('rejects an out-of-range target position', async () => {
    const { doc, ids } = makeDoc(3)
    const host = createDeckToolHost({
      editor: createLocalDeckEditor(new DocumentHistory<DeckDoc>(doc)),
    })
    const outcome = await host.reorder({ slideId: ids[0]!, toPosition: 9 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('index-out-of-range')
  })
})

describe('createDeckToolHost — read + screenshot seam', () => {
  it('resolves by id and by 1-based index', async () => {
    const { doc, ids } = makeDoc(2)
    const host = createDeckToolHost({
      editor: createLocalDeckEditor(new DocumentHistory<DeckDoc>(doc)),
    })
    expect((await host.resolve({ slideId: ids[1]! }))?.index).toBe(2)
    expect((await host.resolve({ index: 2 }))?.id).toBe(ids[1]!)
    expect(await host.resolve({ index: 9 })).toBeNull()
    expect(await host.count()).toBe(2)
  })

  it('reports screenshot-unavailable when no capturer is wired', async () => {
    const { doc, ids } = makeDoc(1)
    const host = createDeckToolHost({
      editor: createLocalDeckEditor(new DocumentHistory<DeckDoc>(doc)),
    })
    const outcome = await host.screenshot(ids[0]!, 0)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('screenshot-unavailable')
  })

  it('delegates to an injected capturer and returns base64 PNG', async () => {
    const { doc, ids } = makeDoc(1)
    const capture = vi.fn(async () => 'BASE64PNG')
    const host = createDeckToolHost({
      editor: createLocalDeckEditor(new DocumentHistory<DeckDoc>(doc)),
      capture,
    })
    const outcome = await host.screenshot(ids[0]!, 250)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.pngBase64).toBe('BASE64PNG')
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ id: ids[0]! }), 250)
  })
})
