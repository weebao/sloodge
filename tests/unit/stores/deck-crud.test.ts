/**
 * M1.4: the store's CRUD actions, seen from two sides.
 *
 * *What the deck looks like afterwards* is the obvious half. The other half — and the one these
 * tests exist for — is *what reached the history*: the whole point of routing add/delete/duplicate/
 * move through `DocumentHistory` is that undo can see them, so every case below asserts the command
 * that was recorded, not just the state that resulted. A store that produced the right deck by
 * mutating it directly would pass the first kind of assertion and fail the second.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  canDeleteSlide,
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'
import type { DocCommand } from '../../../src/shared/document/commands'
import { getSlide } from '../../../src/shared/document/deck'
import type { HistoryEntry } from '../../../src/shared/document/history'
import { parseManifest, type SlideId } from '../../../src/shared/document/types'

const NOW = 1_770_000_000_000
const UNKNOWN_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA' as SlideId

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
})

const state = () => useDeckStore.getState()
const order = (): readonly SlideId[] => state().deck.slideOrder
const lastEntry = (): HistoryEntry | undefined => state().history.undoStack().at(-1)
const forward = (): DocCommand | undefined => lastEntry()?.forward[0]
/** The document as data, for "undo restored *exactly* this" comparisons. */
const document = () => structuredClone({ ...state().history.doc })

describe('the store is a view of its history', () => {
  it('publishes the history document by identity, never a copy of it', () => {
    expect(state().deck).toBe(state().history.doc.manifest)
    expect(state().slideHtml).toBe(state().history.doc.slides)

    state().addSlide()

    expect(state().deck).toBe(state().history.doc.manifest)
    expect(state().slideHtml).toBe(state().history.doc.slides)
  })

  it('starts with an empty history and reports it', () => {
    expect(state().canUndo).toBe(false)
    expect(state().canRedo).toBe(false)
    expect(state().history.undoStack()).toHaveLength(0)
  })

  it('keeps the manifest schema-valid after a round of every mutation', () => {
    const first = order()[0]!
    state().addSlide()
    state().duplicateSlide(first)
    state().moveSlide(0, 3)
    state().deleteSlide(order()[1]!)

    const parsed = parseManifest(JSON.parse(JSON.stringify(state().deck)))
    expect(parsed.ok ? [] : parsed.issues).toEqual([])
  })
})

describe('addSlide', () => {
  it('appends through a slide.insert command and selects the new slide', () => {
    const before = order().length
    expect(state().addSlide()).toBe(true)

    expect(order()).toHaveLength(before + 1)
    const added = order().at(-1)!
    expect(state().currentSlideId).toBe(added)

    expect(lastEntry()?.origin).toEqual({ kind: 'user', label: 'New slide' })
    expect(lastEntry()?.forward).toHaveLength(1)
    expect(forward()).toMatchObject({ t: 'slide.insert', at: before })
    expect(state().canUndo).toBe(true)
  })

  it('gives the new slide contract-compliant starter HTML of its own', () => {
    state().addSlide()
    const added = order().at(-1)!
    const html = getSlideHtml(state().slideHtml, added)

    expect(html).toContain(`data-sl-slide="${added}"`)
    expect(html).toContain('data-sl-contract="1"')
    expect(getSlide(state().deck, added)?.title).toBe('Untitled slide')
  })
})

describe('deleteSlide', () => {
  it('removes through a slide.remove command', () => {
    const [, second] = order()
    expect(state().deleteSlide(second!)).toBe(true)

    expect(order()).toHaveLength(2)
    expect(order()).not.toContain(second)
    expect(getSlideHtml(state().slideHtml, second!)).toBeUndefined()
    expect(forward()).toEqual({ t: 'slide.remove', id: second })
    expect(lastEntry()?.label).toBe('Delete slide')
  })

  it('selects the following slide when the current one is deleted', () => {
    const [, second, third] = order()
    state().selectSlide(second!)
    state().deleteSlide(second!)

    expect(state().currentSlideId).toBe(third)
  })

  it('selects the *next* slide, not the last one, in a deck long enough to tell them apart', () => {
    // Three slides cannot distinguish "the one after it" from "the one at the end"; four can.
    state().addSlide()
    const [, second, third] = order()
    state().selectSlide(second!)
    state().deleteSlide(second!)

    expect(order()).toHaveLength(3)
    expect(state().currentSlideId).toBe(third)
    expect(state().currentSlideId).not.toBe(order().at(-1))
  })

  it('selects the previous slide when the deleted one was last', () => {
    const [, second, third] = order()
    state().selectSlide(third!)
    state().deleteSlide(third!)

    expect(state().currentSlideId).toBe(second)
  })

  it('leaves the selection alone when some other slide is deleted', () => {
    const [first, second] = order()
    state().selectSlide(first!)
    state().deleteSlide(second!)

    expect(state().currentSlideId).toBe(first)
  })

  it('refuses the last slide, and records nothing when it does', () => {
    state().deleteSlide(order()[0]!)
    state().deleteSlide(order()[0]!)
    const survivor = order()[0]!
    const depth = state().history.undoStack().length

    expect(canDeleteSlide(state().deck, survivor)).toBe(false)
    expect(state().deleteSlide(survivor)).toBe(false)
    expect(order()).toEqual([survivor])
    expect(state().currentSlideId).toBe(survivor)
    expect(state().history.undoStack()).toHaveLength(depth)
  })

  it('declines an id the deck does not hold', () => {
    expect(state().deleteSlide(UNKNOWN_ID)).toBe(false)
    expect(state().history.undoStack()).toHaveLength(0)
  })

  it('does not resolve an id through the prototype chain', () => {
    expect(state().deleteSlide('constructor' as SlideId)).toBe(false)
    expect(state().deleteSlide('__proto__' as SlideId)).toBe(false)
    expect(order()).toHaveLength(3)
  })
})

describe('duplicateSlide', () => {
  it('inserts the copy directly after the original and selects it', () => {
    const [first, second, third] = order()
    expect(state().duplicateSlide(first!)).toBe(true)

    const copy = order()[1]!
    expect(copy).not.toBe(first)
    expect(order()).toEqual([first, copy, second, third])
    expect(state().currentSlideId).toBe(copy)
    expect(forward()).toMatchObject({ t: 'slide.insert', at: 1 })
    expect(lastEntry()?.label).toBe('Duplicate slide')
  })

  it('copies the bytes and the title, and resets the copy’s validation', () => {
    const first = order()[0]!
    state().duplicateSlide(first)
    const copy = order()[1]!

    expect(getSlideHtml(state().slideHtml, copy)).toBe(getSlideHtml(state().slideHtml, first))
    expect(getSlide(state().deck, copy)?.title).toBe(getSlide(state().deck, first)?.title)
    expect(getSlide(state().deck, copy)?.file).toBe(`slides/${copy}.html`)
    expect(getSlide(state().deck, copy)?.validation).toEqual({ status: 'unknown' })
  })

  it('declines an unknown id', () => {
    expect(state().duplicateSlide(UNKNOWN_ID)).toBe(false)
    expect(order()).toHaveLength(3)
    expect(state().history.undoStack()).toHaveLength(0)
  })
})

describe('moveSlide', () => {
  it('reorders through a slide.move command and keeps the moved slide selected', () => {
    const [first, second, third] = order()
    expect(state().moveSlide(0, 2)).toBe(true)

    expect(order()).toEqual([second, third, first])
    expect(state().currentSlideId).toBe(first)
    expect(forward()).toEqual({ t: 'slide.move', id: first, to: 2 })
    expect(lastEntry()?.label).toBe('Move slide')
  })

  it('moves backwards too', () => {
    const [first, second, third] = order()
    state().moveSlide(2, 0)

    expect(order()).toEqual([third, first, second])
  })

  it('records nothing for a drop that changes nothing', () => {
    expect(state().moveSlide(1, 1)).toBe(false)
    expect(state().canUndo).toBe(false)
  })

  it('declines indices outside the deck', () => {
    expect(state().moveSlide(0, 3)).toBe(false)
    expect(state().moveSlide(0, -1)).toBe(false)
    expect(state().moveSlide(7, 0)).toBe(false)
    expect(state().moveSlide(0, 1.5)).toBe(false)
    expect(state().history.undoStack()).toHaveLength(0)
  })
})

describe('undo and redo', () => {
  it('restores the document exactly, byte for byte, after every action', () => {
    const cases: readonly (() => void)[] = [
      () => void state().addSlide(),
      () => void state().duplicateSlide(order()[1]!),
      () => void state().deleteSlide(order()[1]!),
      () => void state().moveSlide(0, 2),
    ]

    for (const act of cases) {
      useDeckStore.setState(createStarterDeck(NOW))
      const before = document()
      act()
      expect(state().history.doc).not.toEqual(before)
      expect(state().undo()).toBe(true)
      expect(document()).toEqual(before)
    }
  })

  it('walks the flags as the stacks move', () => {
    expect(state().canUndo).toBe(false)
    state().addSlide()
    expect([state().canUndo, state().canRedo]).toEqual([true, false])
    state().undo()
    expect([state().canUndo, state().canRedo]).toEqual([false, true])
    state().redo()
    expect([state().canUndo, state().canRedo]).toEqual([true, false])
  })

  it('declines with nothing to undo or redo', () => {
    expect(state().undo()).toBe(false)
    expect(state().redo()).toBe(false)
    state().addSlide()
    expect(state().redo()).toBe(false)
  })

  it('redoes the same edit it undid', () => {
    const first = order()[0]!
    state().moveSlide(0, 2)
    state().undo()
    expect(order()[0]).toBe(first)

    expect(state().redo()).toBe(true)
    expect(order().at(-1)).toBe(first)
    expect(state().currentSlideId).toBe(first)
  })

  it('keeps a selection that survived the undo', () => {
    const [first, second] = order()
    state().selectSlide(first!)
    state().deleteSlide(second!)
    state().undo()

    expect(order()).toHaveLength(3)
    expect(state().currentSlideId).toBe(first)
  })

  it('falls back to the nearest surviving slide when the selection is undone away', () => {
    // `addSlide` selects the slide it appended; undoing it deletes the slide under the selection.
    state().addSlide()
    const added = state().currentSlideId
    state().undo()

    expect(order()).toHaveLength(3)
    expect(state().currentSlideId).not.toBe(added)
    // The added slide sat at index 3; the nearest surviving position is the new last slide.
    expect(state().currentSlideId).toBe(order().at(-1))
  })

  it('restores the selection to a slide that undo brought back, by position', () => {
    const [, second, third] = order()
    state().selectSlide(third!)
    // Deleting the selected last slide moves the selection to `second`, which then survives.
    state().deleteSlide(third!)
    expect(state().currentSlideId).toBe(second)

    state().undo()
    expect(order()).toHaveLength(3)
    expect(state().currentSlideId).toBe(second)
  })
})
