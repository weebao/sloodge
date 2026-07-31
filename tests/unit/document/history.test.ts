import { describe, expect, it } from 'vitest'
import type { DeckDoc, DocCommand } from '../../../src/shared/document/commands'
import { createSlideEntry, newSlideId } from '../../../src/shared/document/deck'
import {
  DEFAULT_MAX_HISTORY_BYTES,
  DEFAULT_MAX_HISTORY_ENTRIES,
  DocumentHistory,
  type CommandOrigin,
  type HistoryResult,
} from '../../../src/shared/document/history'
import { makeDoc, makeTheme, T0 } from './deck-doc-fixture'

const USER: CommandOrigin = { kind: 'user', label: 'Edit slide' }

function expectOk<D>(result: HistoryResult<D>): D {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`)
  }
  return result.doc
}

function expectErr<D>(result: HistoryResult<D>) {
  if (result.ok) throw new Error('expected an error, got ok')
  return result.error
}

/** A history over a 3-slide themed deck, plus the pristine document to compare against. */
function makeHistory(options: { maxEntries?: number; maxBytes?: number } = {}) {
  const { doc, ids } = makeDoc(3, { theme: makeTheme() })
  const initial = structuredClone(doc)
  let ticks = 0
  const history = new DocumentHistory<DeckDoc>(doc, {
    ...options,
    now: () => T0 + (ticks += 1),
  })
  return { history, ids, initial }
}

describe('apply', () => {
  it('mutates the document, bumps the revision and records one entry', () => {
    const { history, ids } = makeHistory()
    expect(history.rev).toBe(0)
    expect(history.canUndo).toBe(false)

    const doc = expectOk(history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER))
    expect(doc.slides[ids[0]!]).toBe('a')
    expect(history.doc).toBe(doc)
    expect(history.rev).toBe(1)
    expect(history.undoStack()).toHaveLength(1)
    expect(history.summary()).toMatchObject({
      rev: 1,
      canUndo: true,
      canRedo: false,
      undoLabel: 'Edit slide',
      redoLabel: null,
    })
  })

  it('labels an entry from its origin, and lets the caller override', () => {
    const { history, ids } = makeHistory()
    history.apply([{ t: 'slide.remove', id: ids[0]! }], USER, 'Delete slide')
    expect(history.summary().undoLabel).toBe('Delete slide')

    history.apply([{ t: 'slide.setHtml', id: ids[1]!, html: 'b' }], {
      kind: 'agent',
      turnId: 't1',
      toolUseId: 'u1',
    })
    expect(history.summary().undoLabel).toBe('AI edit')
    expect(history.undoStack().at(-1)?.origin).toEqual({
      kind: 'agent',
      turnId: 't1',
      toolUseId: 'u1',
    })
  })

  it('leaves the document and the stacks untouched when a batch fails', () => {
    const { history, ids } = makeHistory()
    const before = history.doc
    const error = expectErr(
      history.apply(
        [
          { t: 'slide.setHtml', id: ids[0]!, html: 'a' },
          { t: 'slide.remove', id: newSlideId(T0) },
        ],
        USER,
      ),
    )
    expect(error.code).toBe('slide-not-found')
    expect(error.index).toBe(1)
    expect(history.doc).toBe(before)
    expect(history.rev).toBe(0)
    expect(history.canUndo).toBe(false)
  })

  it('records the revision each entry produced', () => {
    const { history, ids } = makeHistory()
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER)
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'b' }], USER)
    expect(history.undoStack().map((entry) => entry.rev)).toEqual([1, 2])
    expect(history.undoStack().map((entry) => entry.ts)).toEqual([T0 + 1, T0 + 2])
  })
})

describe('undo and redo', () => {
  it('restores the exact starting document and replays back to the end state', () => {
    const { history, ids, initial } = makeHistory()
    const entry = createSlideEntry({ now: T0 + 40, title: 'Added' })
    const batches: DocCommand[][] = [
      [{ t: 'slide.setHtml', id: ids[0]!, html: '<main>rewritten</main>' }],
      [{ t: 'slide.remove', id: ids[1]! }],
      [
        { t: 'slide.insert', at: 0, slide: entry, html: '<main>added</main>' },
        { t: 'slide.move', id: ids[2]!, to: 0 },
      ],
      [{ t: 'deck.setMeta', meta: { title: 'Renamed' } }],
      [{ t: 'deck.setThemeTokens', patch: { color: { accent: '#ff0055' } } }],
      [{ t: 'slide.setNotes', id: ids[0]!, notes: null }],
    ]
    for (const batch of batches) expectOk(history.apply(batch, USER))
    const final = structuredClone(history.doc)
    expect(history.rev).toBe(batches.length)

    for (let index = 0; index < batches.length; index += 1) expectOk(history.undo())
    expect(history.doc).toEqual(initial)
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)
    expect(history.rev).toBe(batches.length * 2)

    for (let index = 0; index < batches.length; index += 1) expectOk(history.redo())
    expect(history.doc).toEqual(final)
    expect(history.canRedo).toBe(false)
    expect(history.rev).toBe(batches.length * 3)
  })

  it('moves entries between the stacks rather than dropping them', () => {
    const { history, ids } = makeHistory()
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER, 'first')
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'b' }], USER, 'second')
    expectOk(history.undo())
    expect(history.summary()).toMatchObject({ undoLabel: 'first', redoLabel: 'second' })
    expect(history.doc.slides[ids[0]!]).toBe('a')
    expectOk(history.redo())
    expect(history.summary()).toMatchObject({ undoLabel: 'second', redoLabel: null })
    expect(history.doc.slides[ids[0]!]).toBe('b')
  })

  it('clears the redo stack when a new command is applied', () => {
    // Revert-proof guard: without the clear, this redo replays a command computed against a
    // document that has since diverged — the classic corrupt-the-deck undo bug.
    const { history, ids } = makeHistory()
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER)
    expectOk(history.undo())
    expect(history.canRedo).toBe(true)

    history.apply([{ t: 'slide.setHtml', id: ids[1]!, html: 'divergent' }], USER)
    expect(history.canRedo).toBe(false)
    expect(expectErr(history.redo()).code).toBe('nothing-to-redo')
  })

  it('replays the command it recorded, not the object the caller kept', () => {
    // Revert-proof guard for the deep copy in `apply`: a shallow `[...commands]` retains the
    // caller's objects, so mutating one after `apply` returned rewrites history — `redo()` then
    // replays an edit the user never made.
    const { history, ids } = makeHistory()
    const command: DocCommand = { t: 'slide.setHtml', id: ids[0]!, html: 'recorded' }
    expectOk(history.apply([command], USER))
    expectOk(history.undo())

    command.html = 'MUTATED'
    expectOk(history.redo())
    expect(history.doc.slides[ids[0]!]).toBe('recorded')
    expect(history.undoStack()[0]?.forward[0]).toMatchObject({ html: 'recorded' })
  })

  it('does not touch the document or the stacks when an undo cannot be applied', () => {
    // The defensive branch in `undo()`, reached the only way it can be: an entry whose inverse is
    // no longer applicable. Popping before checking would strand the document mid-rollback.
    const { history, ids } = makeHistory()
    expectOk(history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER))
    const before = history.doc
    const entry = history.undoStack()[0]!
    entry.inverse = [{ t: 'slide.remove', id: newSlideId(T0) }]

    expect(expectErr(history.undo()).code).toBe('slide-not-found')
    expect(history.doc).toBe(before)
    expect(history.rev).toBe(1)
    expect(history.undoStack()).toHaveLength(1)
    expect(history.redoStack()).toHaveLength(0)
  })

  it('reports an empty stack instead of silently doing nothing', () => {
    const { history, ids } = makeHistory()
    expect(expectErr(history.undo()).code).toBe('nothing-to-undo')
    expect(expectErr(history.redo()).code).toBe('nothing-to-redo')
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER)
    expectOk(history.undo())
    expect(expectErr(history.undo()).code).toBe('nothing-to-undo')
  })
})

describe('bounds', () => {
  it('defaults to the caps the architecture doc specifies', () => {
    const { doc } = makeDoc(1)
    const history = new DocumentHistory(doc)
    expect(history.maxEntries).toBe(DEFAULT_MAX_HISTORY_ENTRIES)
    expect(history.maxBytes).toBe(DEFAULT_MAX_HISTORY_BYTES)
    expect(DEFAULT_MAX_HISTORY_ENTRIES).toBe(200)
  })

  it('falls back to the default when handed a depth that would disable undo', () => {
    const { doc, ids } = makeDoc(1)
    const history = new DocumentHistory<DeckDoc>(doc, { maxEntries: 0 })
    expect(history.maxEntries).toBe(DEFAULT_MAX_HISTORY_ENTRIES)
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER)
    expect(history.canUndo).toBe(true)
  })

  it('evicts oldest-first at the depth cap', () => {
    // Revert-proof guard for the eviction *order*: dropping the newest instead would keep the
    // stack the same size and only reveal itself as "Ctrl+Z does nothing" at runtime.
    const { history, ids } = makeHistory({ maxEntries: 3 })
    for (let index = 0; index < 5; index += 1) {
      history.apply(
        [{ t: 'slide.setHtml', id: ids[0]!, html: `v${String(index)}` }],
        USER,
        `#${String(index)}`,
      )
    }
    expect(history.undoStack().map((entry) => entry.label)).toEqual(['#2', '#3', '#4'])

    expectOk(history.undo())
    expect(history.doc.slides[ids[0]!]).toBe('v3')
    expectOk(history.undo())
    expectOk(history.undo())
    expect(history.doc.slides[ids[0]!]).toBe('v1')
    expect(expectErr(history.undo()).code).toBe('nothing-to-undo')
  })

  it('evicts under the byte cap but never drops the newest entry', () => {
    const { history, ids } = makeHistory({ maxBytes: 4096 })
    for (let index = 0; index < 6; index += 1) {
      history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'x'.repeat(1024) }], USER)
    }
    expect(history.undoStack().length).toBeLessThan(6)
    expect(history.retainedBytes).toBeLessThanOrEqual(4096)

    const tiny = new DocumentHistory<DeckDoc>(makeDoc(1).doc, { maxBytes: 16 })
    const only = makeDoc(1)
    tiny.reset(only.doc)
    tiny.apply([{ t: 'slide.setHtml', id: only.ids[0]!, html: 'y'.repeat(100_000) }], USER)
    expect(tiny.undoStack()).toHaveLength(1)
    expect(tiny.canUndo).toBe(true)
  })
})

describe('transactions', () => {
  it('collapses every batch in a turn into one undo step', () => {
    // Revert-proof guard for the whole mechanism: without accumulation the stack holds three
    // entries and one undo restores only the last batch.
    const { history, ids, initial } = makeHistory()
    expectOk(history.beginTransaction('AI: "make it corporate"'))
    expect(history.inTransaction).toBe(true)
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], {
      kind: 'agent',
      turnId: 't1',
      toolUseId: 'u1',
    })
    history.apply([{ t: 'slide.setHtml', id: ids[1]!, html: 'b' }], {
      kind: 'agent',
      turnId: 't1',
      toolUseId: 'u2',
    })
    history.apply([{ t: 'deck.setThemeTokens', patch: { color: { accent: '#101010' } } }], {
      kind: 'agent',
      turnId: 't1',
      toolUseId: 'u3',
    })
    expect(history.undoStack()).toHaveLength(0)
    expect(history.canUndo).toBe(false)

    expectOk(history.commitTransaction())
    expect(history.inTransaction).toBe(false)
    expect(history.undoStack()).toHaveLength(1)
    expect(history.summary().undoLabel).toBe('AI: "make it corporate"')

    expectOk(history.undo())
    expect(history.doc).toEqual(initial)
    expectOk(history.redo())
    expect(history.doc.slides[ids[0]!]).toBe('a')
    expect(history.doc.slides[ids[1]!]).toBe('b')
    expect(history.doc.theme?.tokens.color['accent']).toBe('#101010')
  })

  it('undoes non-commuting batches in reverse order, exactly', () => {
    // Revert-proof guard for `open.inverse.unshift(...)`. The batches below do not commute, so a
    // `push` accumulation undoes them front-to-back and lands on a *different* slide order —
    // silently, in the code path every multi-step agent turn takes.
    const { history, ids, initial } = makeHistory()
    const [s0, s1, s2, s3] = [ids[0]!, ids[1]!, ids[2]!, newSlideId(T0)]
    expect(s3).not.toBe(s2)

    expectOk(history.beginTransaction('AI: "tighten the deck"'))
    expectOk(history.apply([{ t: 'slide.remove', id: s1 }], USER))
    expectOk(history.apply([{ t: 'slide.move', id: s2, to: 0 }], USER))
    expectOk(history.apply([{ t: 'slide.move', id: s0, to: 1 }], USER))
    expectOk(history.commitTransaction())
    expect(history.doc.manifest.slideOrder).toEqual([s2, s0])

    const entry = history.undoStack()[0]!
    expect(entry.forward.map((command) => command.t)).toEqual([
      'slide.remove',
      'slide.move',
      'slide.move',
    ])
    // Reverse of the forward order — the last batch applied is the first one undone.
    expect(entry.inverse.map((command) => command.t)).toEqual([
      'slide.move',
      'slide.move',
      'slide.insert',
    ])

    expectOk(history.undo())
    expect(history.doc.manifest.slideOrder).toEqual([s0, s1, s2])
    expect(history.doc).toEqual(initial)
  })

  it('pushes nothing for a transaction that applied nothing', () => {
    const { history } = makeHistory()
    expectOk(history.beginTransaction('empty turn'))
    expectOk(history.commitTransaction())
    expect(history.undoStack()).toHaveLength(0)
    expect(history.canUndo).toBe(false)
  })

  it('rolls the document back on abort and records no entry', () => {
    const { history, ids, initial } = makeHistory()
    expectOk(history.beginTransaction('bad tool call'))
    history.apply([{ t: 'slide.remove', id: ids[0]! }], USER)
    history.apply([{ t: 'deck.setMeta', meta: { title: 'half done' } }], USER)
    expectOk(history.abortTransaction())

    expect(history.doc).toEqual(initial)
    expect(history.undoStack()).toHaveLength(0)
    expect(history.canUndo).toBe(false)
    expect(history.inTransaction).toBe(false)
    // The rollback is itself a document change, so a replica must see a new revision.
    expect(history.rev).toBe(3)
  })

  it('refuses to nest, to close what is not open, and to undo mid-transaction', () => {
    const { history, ids } = makeHistory()
    expect(expectErr(history.commitTransaction()).code).toBe('no-open-transaction')
    expect(expectErr(history.abortTransaction()).code).toBe('no-open-transaction')

    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER)
    expectOk(history.beginTransaction('turn'))
    expect(expectErr(history.beginTransaction('nested')).code).toBe('transaction-open')
    expect(expectErr(history.undo()).code).toBe('transaction-open')
    expect(expectErr(history.redo()).code).toBe('transaction-open')
    expect(history.canUndo).toBe(false)
    expect(history.summary().inTransaction).toBe(true)
  })
})

describe('reset', () => {
  it('forgets both stacks and moves the revision forward', () => {
    const { history, ids } = makeHistory()
    history.apply([{ t: 'slide.setHtml', id: ids[0]!, html: 'a' }], USER)
    expectOk(history.undo())
    const revBefore = history.rev

    const opened = makeDoc(2).doc
    history.reset(opened)
    expect(history.doc).toBe(opened)
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.retainedBytes).toBe(0)
    // Never backwards: a replica tells snapshots apart by revision.
    expect(history.rev).toBeGreaterThan(revBefore)
  })
})
