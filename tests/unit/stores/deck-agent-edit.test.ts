import { beforeEach, describe, expect, it } from 'vitest'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'
import type { DocCommand } from '../../../src/shared/document/commands'
import { createSlideEntry } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'

const NOW = 1_783_000_000_000

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
})

/** A `slide.insert` command as the agent tool would build it, appended to the end. */
function agentInsert(title: string): { command: DocCommand; id: SlideId } {
  const state = useDeckStore.getState()
  const entry = createSlideEntry({ now: NOW, title, origin: { type: 'agent' } })
  const html = createStarterSlideHtml({ id: entry.id, title })
  return {
    command: { t: 'slide.insert', at: state.deck.slideOrder.length, slide: entry, html },
    id: entry.id,
  }
}

describe('deckStore.applyAgentCommands — undo-parity (M2.6 headline)', () => {
  it('an agent create visibly mutates the deck and is undone by deckStore.undo in one step', () => {
    const before = useDeckStore.getState().deck.slideOrder.length
    const { command, id } = agentInsert('Agent-made slide')

    const result = useDeckStore.getState().applyAgentCommands([command], 'turn-1', 'create_slide')

    // (1) The store the canvas/rail render from is the one that changed…
    expect(result.ok).toBe(true)
    const after = useDeckStore.getState()
    expect(after.deck.slideOrder).toContain(id)
    expect(after.deck.slideOrder).toHaveLength(before + 1)
    expect(getSlideHtml(after.slideHtml, id)).toContain('Agent-made slide')
    // …and the new slide is selected, so the canvas shows what the agent just made.
    expect(after.currentSlideId).toBe(id)
    expect(after.canUndo).toBe(true)

    // (2) The standard Edit-menu undo path reverses the agent edit in ONE step.
    expect(useDeckStore.getState().undo()).toBe(true)
    const undone = useDeckStore.getState()
    expect(undone.deck.slideOrder).not.toContain(id)
    expect(undone.deck.slideOrder).toHaveLength(before)
    expect(undone.canUndo).toBe(false)
    // Redo puts it back — the agent edit is a normal history entry.
    expect(useDeckStore.getState().redo()).toBe(true)
    expect(useDeckStore.getState().deck.slideOrder).toContain(id)
  })

  it('an agent update lands as a single undoable entry', () => {
    const id = useDeckStore.getState().currentSlideId!
    const originalHtml = getSlideHtml(useDeckStore.getState().slideHtml, id)
    const commands: DocCommand[] = [
      { t: 'slide.setHtml', id, html: createStarterSlideHtml({ id, title: 'Rewritten' }) },
      { t: 'slide.setNotes', id, notes: 'agent note' },
    ]

    expect(useDeckStore.getState().applyAgentCommands(commands, 'turn-1', 'update_slide').ok).toBe(
      true,
    )
    expect(getSlideHtml(useDeckStore.getState().slideHtml, id)).toContain('Rewritten')

    // One undo restores both html and notes.
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, id)).toBe(originalHtml)
    expect(useDeckStore.getState().canUndo).toBe(false)
  })

  it('interleaves a manual edit and an agent edit and undoes in LIFO order', () => {
    const start = useDeckStore.getState().deck.slideOrder.length

    // Manual add (user origin), then an agent create.
    expect(useDeckStore.getState().addSlide()).toBe(true)
    const manualId = useDeckStore.getState().currentSlideId!
    const { command: agentCmd, id: agentId } = agentInsert('Agent')
    expect(
      useDeckStore.getState().applyAgentCommands([agentCmd], 'turn-1', 'create_slide').ok,
    ).toBe(true)

    expect(useDeckStore.getState().deck.slideOrder).toHaveLength(start + 2)

    // Undo removes the agent edit first…
    useDeckStore.getState().undo()
    expect(useDeckStore.getState().deck.slideOrder).not.toContain(agentId)
    expect(useDeckStore.getState().deck.slideOrder).toContain(manualId)
    // …then the manual one.
    useDeckStore.getState().undo()
    expect(useDeckStore.getState().deck.slideOrder).not.toContain(manualId)
    expect(useDeckStore.getState().deck.slideOrder).toHaveLength(start)
  })

  it('rejects a command-invalid agent batch without touching the deck or the history', () => {
    // Put a real entry on the undo stack first, so we can prove it survives a rejected batch.
    useDeckStore.getState().addSlide()
    const deckBefore = useDeckStore.getState().deck
    const undoDepthBefore = useDeckStore.getState().history.undoStack().length

    const badMove: DocCommand = { t: 'slide.move', id: deckBefore.slideOrder[0]!, to: 999 }
    const result = useDeckStore.getState().applyAgentCommands([badMove], 'turn-1', 'reorder')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('index-out-of-range')
    // Same deck by reference, and the earlier undo entry is untouched.
    expect(useDeckStore.getState().deck).toBe(deckBefore)
    expect(useDeckStore.getState().history.undoStack()).toHaveLength(undoDepthBefore)
  })

  it('does NOT reset the undo stack (the agent path is not the doc:open snapshot path)', () => {
    // A prior manual edit is on the stack…
    expect(useDeckStore.getState().addSlide()).toBe(true)
    expect(useDeckStore.getState().canUndo).toBe(true)
    const depthBefore = useDeckStore.getState().history.undoStack().length

    // …applying an agent command ADDS to the stack rather than resetting it (unlike applyRemoteDeck).
    const { command } = agentInsert('Kept history')
    useDeckStore.getState().applyAgentCommands([command], 'turn-1', 'create_slide')

    expect(useDeckStore.getState().canUndo).toBe(true)
    expect(useDeckStore.getState().history.undoStack()).toHaveLength(depthBefore + 1)
    // The manual edit is still reachable: undo (agent), undo (manual) both succeed.
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(useDeckStore.getState().undo()).toBe(true)
  })

  it('snapshotForAgent reflects the current authoritative deck', () => {
    const snap = useDeckStore.getState().snapshotForAgent()
    expect(snap.manifest.slideOrder).toEqual(useDeckStore.getState().deck.slideOrder)
    const firstId = snap.manifest.slideOrder[0]!
    expect(snap.slides[firstId]).toBe(getSlideHtml(useDeckStore.getState().slideHtml, firstId))
  })
})
