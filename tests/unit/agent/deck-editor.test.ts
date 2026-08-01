import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRendererDeckEditor,
  type DeckEditorTransport,
  type RendererDeckEditor,
} from '../../../src/main/agent/deck-editor'
import { createDeckToolHost } from '../../../src/main/agent/deck-host'
import { runCreateSlide, runReadSlide, runUpdateSlide } from '../../../src/shared/agent/slide-tools'
import {
  applyAgentCommandsToHistory,
  handleAgentEditRequest,
  snapshotOfDoc,
  type AgentDeckTarget,
} from '../../../src/shared/document/agent-edit'
import { DocumentHistory } from '../../../src/shared/document/history'
import type { DeckDoc } from '../../../src/shared/document/commands'
import { slideCount } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'
import { makeDoc } from '../document/deck-doc-fixture'

const html = (title: string): string =>
  createStarterSlideHtml({ id: 's_01H8XQZ4P7K2M9NB3VYRTC6FDA' as SlideId, title })

/**
 * A fake "renderer" backed by a real `DocumentHistory`: the main-side editor's transport pipes each
 * request straight into the renderer-side `handleAgentEditRequest` and feeds the response back via
 * `deliver`. This is the tool→IPC→history.apply→result loop with fakes on *both* sides — no Electron.
 */
function wireEditor(history: DocumentHistory<DeckDoc>): {
  editor: RendererDeckEditor
  setAlive: (v: boolean) => void
} {
  const target: AgentDeckTarget = {
    applyAgentCommands: (commands, turnId, toolUseId) =>
      applyAgentCommandsToHistory(history, commands, turnId, toolUseId),
    snapshotForAgent: () => snapshotOfDoc(history.doc),
  }
  let alive = true
  let editor!: RendererDeckEditor
  const transport: DeckEditorTransport = {
    isAlive: () => alive,
    send: (request) => {
      editor.deliver(handleAgentEditRequest(target, request))
    },
  }
  editor = createRendererDeckEditor(transport)
  return { editor, setAlive: (v) => (alive = v) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createRendererDeckEditor — round-trip orchestration', () => {
  it('applies a command through the renderer history and returns the new snapshot', async () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(1).doc)
    const { editor } = wireEditor(history)
    const snap = await editor.snapshot()
    expect(snap.ok).toBe(true)

    const applied = await editor.apply(
      [{ t: 'slide.setHtml', id: history.doc.manifest.slideOrder[0]!, html: html('Edited') }],
      'turn-1',
      'update_slide',
    )
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.snapshot.slides[history.doc.manifest.slideOrder[0]!]).toBe(html('Edited'))
    // The edit is on the renderer's undo stack (undo-parity), reversible by that history.
    expect(history.undoStack()).toHaveLength(1)
  })

  it('drives the whole tool path: create → deck mutates → undo restores (fakes on both sides)', async () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(1).doc)
    const { editor } = wireEditor(history)
    const host = createDeckToolHost({ editor, sessionId: 'as_test' })
    const start = slideCount(history.doc.manifest)

    const created = await runCreateSlide(host, { html: html('Intro'), title: 'Intro' })
    expect(created.isError).toBeUndefined()
    const newId = (created.structuredContent as { slideId: SlideId }).slideId
    expect(slideCount(history.doc.manifest)).toBe(start + 1)

    const updated = await runUpdateSlide(host, { slideId: newId, html: html('Introduction') })
    expect(updated.isError).toBeUndefined()

    const read = await runReadSlide(host, { slideId: newId })
    expect((read.structuredContent as { html: string }).html).toBe(html('Introduction'))

    // Exactly two undo entries (create, update) — the standard undo reverses each in one step.
    expect(history.undoStack()).toHaveLength(2)
    expect(history.undo().ok).toBe(true)
    expect(history.doc.slides[newId]).toBe(html('Intro'))
    expect(history.undo().ok).toBe(true)
    expect(slideCount(history.doc.manifest)).toBe(start)
  })
})

describe('createRendererDeckEditor — lifecycle (no hang, typed errors)', () => {
  it('returns renderer-unavailable immediately when the renderer is gone', async () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(1).doc)
    const { editor, setAlive } = wireEditor(history)
    setAlive(false)

    const applied = await editor.apply([{ t: 'slide.remove', id: 'x' as SlideId }], 't', 'u')
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.code).toBe('renderer-unavailable')

    const snap = await editor.snapshot()
    expect(snap.ok).toBe(false)
  })

  it('the tool host surfaces renderer-unavailable as an actionable isError result', async () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(1).doc)
    const { editor, setAlive } = wireEditor(history)
    const host = createDeckToolHost({ editor })
    setAlive(false)

    const result = await runCreateSlide(host, { html: html('Nope'), title: 'Nope' })
    expect(result.isError).toBe(true)
  })

  it('times out to renderer-unavailable if no response ever arrives (no hang)', async () => {
    vi.useFakeTimers()
    const silent: DeckEditorTransport = { isAlive: () => true, send: () => {} }
    const editor = createRendererDeckEditor(silent, { timeoutMs: 1000 })

    const pending = editor.apply([{ t: 'slide.remove', id: 'x' as SlideId }], 't', 'u')
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('renderer-unavailable')
  })

  it('rejectAll fails every in-flight request with a typed error', async () => {
    const silent: DeckEditorTransport = { isAlive: () => true, send: () => {} }
    const editor = createRendererDeckEditor(silent, { timeoutMs: 60_000 })
    const pending = editor.snapshot()
    editor.rejectAll()
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('renderer-unavailable')
  })

  it('ignores a stale response for an already-settled request', async () => {
    const history = new DocumentHistory<DeckDoc>(makeDoc(1).doc)
    const { editor } = wireEditor(history)
    const first = await editor.snapshot()
    expect(first.ok).toBe(true)
    // A duplicate/stale response for a requestId no longer pending is a no-op, not a throw.
    expect(() => editor.deliver({ requestId: 'de_1', op: 'snapshot', result: first })).not.toThrow()
  })
})
