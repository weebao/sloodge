import { describe, expect, it } from 'vitest'
import {
  applyAgentCommandsToHistory,
  handleAgentEditRequest,
  isAgentEditRequest,
  isAgentEditResponse,
  snapshotOfDoc,
  type AgentDeckTarget,
  type AgentEditResponse,
} from '../../../src/shared/document/agent-edit'
import { DocumentHistory } from '../../../src/shared/document/history'
import type { DeckDoc, DocCommand } from '../../../src/shared/document/commands'
import { createSlideEntry, slideCount } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'
import { makeDoc } from './deck-doc-fixture'

const T = 1_782_000_000_000

function insertCommand(title: string): { command: DocCommand; id: SlideId } {
  const entry = createSlideEntry({ now: T, title, origin: { type: 'agent' } })
  const html = createStarterSlideHtml({ id: entry.id, title })
  return { command: { t: 'slide.insert', at: 0, slide: entry, html }, id: entry.id }
}

describe('applyAgentCommandsToHistory — the undo-parity funnel', () => {
  it('records exactly one agent-tagged undo entry per apply, reversible in one step', () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(2).doc)
    const before = slideCount(history.doc.manifest)
    const { command, id } = insertCommand('Agent slide')

    const result = applyAgentCommandsToHistory(history, [command], 'turn-1', 'create_slide')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The command landed on the deck…
    expect(slideCount(history.doc.manifest)).toBe(before + 1)
    expect(result.snapshot.manifest.slideOrder).toContain(id)
    // …as ONE entry, tagged agent, on the same undo stack a manual edit uses.
    expect(history.undoStack()).toHaveLength(1)
    expect(history.undoStack()[0]?.origin.kind).toBe('agent')
    // …and the standard undo reverses it in a single step.
    expect(history.undo().ok).toBe(true)
    expect(slideCount(history.doc.manifest)).toBe(before)
    expect(history.canUndo).toBe(false)
  })

  it('collapses a multi-command batch (setHtml + setNotes) into one undo entry', () => {
    const { doc, ids } = makeDoc(1)
    const history = new DocumentHistory<DeckDoc>(doc)
    const id = ids[0]!
    const commands: DocCommand[] = [
      { t: 'slide.setHtml', id, html: createStarterSlideHtml({ id, title: 'Edited' }) },
      { t: 'slide.setNotes', id, notes: 'agent note' },
    ]

    const result = applyAgentCommandsToHistory(history, commands, 'turn-1', 'update_slide')
    expect(result.ok).toBe(true)
    // Two commands, one apply → one undoable entry (not two).
    expect(history.undoStack()).toHaveLength(1)

    history.undo()
    expect(history.doc.slides[id]).toBe(doc.slides[id])
    expect(history.doc.notes[id]).toBe(doc.notes[id])
    expect(history.canUndo).toBe(false)
  })

  it('rejects a command-invalid batch without touching the deck or the history', () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(3).doc)
    const deckBefore = history.doc.manifest
    const revBefore = history.rev
    // Move to an out-of-range index — the funnel rejects it.
    const badMove: DocCommand = { t: 'slide.move', id: history.doc.manifest.slideOrder[0]!, to: 99 }

    const result = applyAgentCommandsToHistory(history, [badMove], 'turn-1', 'reorder')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('index-out-of-range')
    // Nothing changed: same manifest by reference, same rev, empty undo stack.
    expect(history.doc.manifest).toBe(deckBefore)
    expect(history.rev).toBe(revBefore)
    expect(history.canUndo).toBe(false)
  })

  it('interleaves agent and manual edits and undoes them in LIFO order', () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(1).doc)
    const start = slideCount(history.doc.manifest)

    // Manual edit first…
    const manual = insertCommand('Manual')
    history.apply([manual.command], { kind: 'user', label: 'New slide' })
    // …then an agent edit.
    const agent = insertCommand('Agent')
    applyAgentCommandsToHistory(history, [agent.command], 'turn-1', 'create_slide')

    expect(slideCount(history.doc.manifest)).toBe(start + 2)
    expect(history.undoStack().map((e) => e.origin.kind)).toEqual(['user', 'agent'])

    // Undo removes the agent edit first (LIFO), then the manual one.
    history.undo()
    expect(history.doc.manifest.slideOrder).not.toContain(agent.id)
    expect(history.doc.manifest.slideOrder).toContain(manual.id)
    history.undo()
    expect(history.doc.manifest.slideOrder).not.toContain(manual.id)
    expect(slideCount(history.doc.manifest)).toBe(start)
  })
})

function targetOf(history: DocumentHistory<DeckDoc>): AgentDeckTarget {
  return {
    applyAgentCommands: (commands, turnId, toolUseId) =>
      applyAgentCommandsToHistory(history, commands, turnId, toolUseId),
    snapshotForAgent: () => snapshotOfDoc(history.doc),
  }
}

describe('handleAgentEditRequest', () => {
  it('answers a snapshot request from the authoritative deck', () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(2).doc)
    const response = handleAgentEditRequest(targetOf(history), { requestId: 'r1', op: 'snapshot' })
    expect(response.op).toBe('snapshot')
    if (response.op !== 'snapshot' || !response.result.ok) throw new Error('unexpected')
    expect(response.result.snapshot.manifest.slideOrder).toEqual(history.doc.manifest.slideOrder)
  })

  it('applies an apply request and echoes the requestId', () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(1).doc)
    const { command } = insertCommand('Via request')
    const response = handleAgentEditRequest(targetOf(history), {
      requestId: 'r2',
      op: 'apply',
      commands: [command],
      turnId: 'turn-1',
      toolUseId: 'create_slide',
    })
    expect(response.requestId).toBe('r2')
    expect(response.op).toBe('apply')
    if (response.op !== 'apply' || !response.result.ok) throw new Error('unexpected')
    expect(history.undoStack()).toHaveLength(1)
  })
})

describe('shape gates', () => {
  it('accepts well-formed requests and rejects malformed ones', () => {
    expect(isAgentEditRequest({ requestId: 'x', op: 'snapshot' })).toBe(true)
    expect(isAgentEditRequest({ requestId: 'x', op: 'apply', commands: [] })).toBe(true)
    expect(isAgentEditRequest({ requestId: 'x', op: 'apply' })).toBe(false)
    expect(isAgentEditRequest({ op: 'snapshot' })).toBe(false)
    expect(isAgentEditRequest(null)).toBe(false)
    expect(isAgentEditRequest('snapshot')).toBe(false)
  })

  it('accepts well-formed responses and rejects malformed ones', () => {
    const good: AgentEditResponse = {
      requestId: 'x',
      op: 'snapshot',
      result: { ok: true, snapshot: snapshotOfDoc(makeDoc(1).doc) },
    }
    expect(isAgentEditResponse(good)).toBe(true)
    expect(isAgentEditResponse({ requestId: 'x', op: 'apply', result: { ok: false } })).toBe(true)
    expect(isAgentEditResponse({ requestId: 'x', op: 'nope', result: { ok: true } })).toBe(false)
    expect(isAgentEditResponse({ requestId: 'x', op: 'apply' })).toBe(false)
    expect(isAgentEditResponse(null)).toBe(false)
  })
})
