/**
 * `SlideToolHost` implemented over the M1.2 command layer and M1.3 history — the bridge between the
 * pure `mcp__slides__*` handlers (`src/shared/agent/slide-tools.ts`) and a live deck.
 *
 * Every mutating method builds a `DocCommand` and dispatches it through `DocumentHistory.apply`
 * tagged `origin: { kind: "agent" }`, so an agent edit lands on the same undo stack as a manual one
 * (50-agent-integration.md §6, 10-architecture.md §5) — Ctrl+Z reverses it identically. Nothing here
 * reaches into the deck directly, writes a file, or reads outside the document: the tool server's
 * entire mutation surface is these commands, which is what confines the agent to the document
 * sandbox (§7 — Bash/Write/Edit are already denied at the SDK level in M2.1).
 *
 * `electron`-free and injectable: it takes a `DocumentHistory<DeckBundle>`, an optional change
 * notifier (the `deck:updated` push seam of §9), and an optional screenshot capturer. Tests drive it
 * with a real in-memory bundle and a fake capturer — no renderer, no subprocess.
 *
 * ## Deferred: the real screenshot render
 *
 * `screenshot` delegates to an injected `capture` function. Wiring that to an offscreen
 * `BrowserWindow` + `webContents.capturePage()` (§6, §17) is the integration piece that depends on
 * the renderer surface and is **deliberately out of this milestone** — a host constructed without a
 * capturer returns `screenshot-unavailable`, and the interface + a testable fake prove the tool
 * contract end-to-end (fake SDK-less handler → host → deck mutates → undo restores) without it.
 */

import {
  createSlideEntry,
  getSlide,
  indexOfSlide,
  slideCount,
  slidesInOrder,
} from '../../shared/document/deck'
import type { DeckDoc, DocCommand } from '../../shared/document/commands'
import type { CommandOrigin, DocumentHistory, HistoryError } from '../../shared/document/history'
import type {
  CreateSlideRequest,
  HostErrorCode,
  HostOutcome,
  ReorderRequest,
  ResolvedSlide,
  SlideRef,
  SlideToolHost,
  UpdateSlideRequest,
} from '../../shared/agent/slide-tools'

/** Renders a resolved slide to a base64 PNG. Wiring to the offscreen renderer is deferred (§17). */
export type SlideScreenshotFn = (slide: ResolvedSlide, atMs: number) => Promise<string>

export type DeckToolHostDeps = {
  /** The live deck history the tools mutate. `doc` must be a `DeckBundle`-shaped `DeckDoc`. */
  readonly history: DocumentHistory<DeckDoc>
  /** The conversation this host serves — recorded on `origin` for agent-tagged undo entries. */
  readonly sessionId?: string
  /** Pushed after every successful mutation so thumbnails rerender mid-turn (§9). */
  readonly onChange?: () => void
  /** Offscreen render, injected. Absent → `screenshot` returns `screenshot-unavailable`. */
  readonly capture?: SlideScreenshotFn
  /** Injectable clock so created-entry timestamps are deterministic in tests. */
  readonly now?: () => number
}

function agentOrigin(sessionId: string | undefined, tool: string): CommandOrigin {
  return { kind: 'agent', turnId: sessionId ?? 'agent', toolUseId: tool }
}

/** Map a history/command error onto a host outcome the model can act on. */
function fromHistoryError<T>(error: HistoryError): HostOutcome<T> & { ok: false } {
  const code: HostErrorCode =
    error.code === 'slide-not-found'
      ? 'slide-not-found'
      : error.code === 'index-out-of-range'
        ? 'index-out-of-range'
        : 'invalid'
  return { ok: false, code, message: error.message }
}

export function createDeckToolHost(deps: DeckToolHostDeps): SlideToolHost {
  const { history, sessionId, onChange, capture } = deps
  const now = deps.now ?? Date.now

  const resolveById = (id: string): ResolvedSlide | null => {
    const entry = getSlide(history.doc.manifest, id)
    if (!entry) return null
    const index = indexOfSlide(history.doc.manifest, id)
    if (index === -1) return null
    const html = Object.hasOwn(history.doc.slides, id) ? history.doc.slides[id]! : ''
    const notes = Object.hasOwn(history.doc.notes, id) ? history.doc.notes[id]! : null
    return {
      id: entry.id,
      index: index + 1,
      title: entry.title,
      notes,
      html,
      capabilities: entry.capabilities ?? ['static'],
    }
  }

  return {
    resolve(ref: SlideRef): ResolvedSlide | null {
      if (ref.slideId !== undefined) return resolveById(ref.slideId)
      if (ref.index !== undefined) {
        const order = history.doc.manifest.slideOrder
        const id = order[ref.index - 1]
        return id === undefined ? null : resolveById(id)
      }
      return null
    },

    list() {
      return slidesInOrder(history.doc.manifest).map((slide, i) => ({
        id: slide.id,
        index: i + 1,
        title: slide.title,
      }))
    },

    count() {
      return slideCount(history.doc.manifest)
    },

    create(request: CreateSlideRequest): HostOutcome<{ slideId: string; index: number }> {
      const count = slideCount(history.doc.manifest)
      if (
        request.position !== undefined &&
        (request.position < 1 || request.position > count + 1)
      ) {
        return {
          ok: false,
          code: 'index-out-of-range',
          message: `position ${String(request.position)} is out of range; the deck has ${String(count)} slides`,
        }
      }
      const entry = createSlideEntry({
        title: request.title,
        capabilities: request.capabilities,
        withNotes: request.notes !== undefined,
        origin: { type: 'agent', ...(sessionId !== undefined ? { sessionId } : {}) },
        now: now(),
      })
      const at = request.position !== undefined ? request.position - 1 : count
      const command: DocCommand = {
        t: 'slide.insert',
        at,
        slide: entry,
        html: request.html,
        ...(request.notes !== undefined ? { notes: request.notes } : {}),
      }
      const applied = history.apply([command], agentOrigin(sessionId, 'create_slide'))
      if (!applied.ok) return fromHistoryError(applied.error)
      const index = indexOfSlide(history.doc.manifest, entry.id) + 1
      onChange?.()
      return { ok: true, value: { slideId: entry.id, index } }
    },

    update(
      request: UpdateSlideRequest,
    ): HostOutcome<{ slideId: string; index: number; revision: number }> {
      if (!getSlide(history.doc.manifest, request.slideId)) {
        return {
          ok: false,
          code: 'slide-not-found',
          message: `no slide with id ${request.slideId}`,
        }
      }
      const commands: DocCommand[] = []
      if (request.html !== undefined) {
        commands.push({ t: 'slide.setHtml', id: request.slideId, html: request.html })
      }
      if (request.notes !== undefined) {
        commands.push({ t: 'slide.setNotes', id: request.slideId, notes: request.notes })
      }
      if (commands.length === 0) {
        return { ok: false, code: 'invalid', message: 'update needs html or notes' }
      }
      const applied = history.apply(commands, agentOrigin(sessionId, 'update_slide'))
      if (!applied.ok) return fromHistoryError(applied.error)
      const index = indexOfSlide(history.doc.manifest, request.slideId) + 1
      onChange?.()
      return { ok: true, value: { slideId: request.slideId, index, revision: history.rev } }
    },

    reorder(request: ReorderRequest): HostOutcome<{ order: string[] }> {
      const count = slideCount(history.doc.manifest)
      if (!getSlide(history.doc.manifest, request.slideId)) {
        return {
          ok: false,
          code: 'slide-not-found',
          message: `no slide with id ${request.slideId}`,
        }
      }
      if (request.toPosition < 1 || request.toPosition > count) {
        return {
          ok: false,
          code: 'index-out-of-range',
          message: `position ${String(request.toPosition)} is out of range; the deck has ${String(count)} slides`,
        }
      }
      const command: DocCommand = {
        t: 'slide.move',
        id: request.slideId,
        to: request.toPosition - 1,
      }
      const applied = history.apply([command], agentOrigin(sessionId, 'reorder'))
      if (!applied.ok) return fromHistoryError(applied.error)
      onChange?.()
      return { ok: true, value: { order: slidesInOrder(history.doc.manifest).map((s) => s.id) } }
    },

    async screenshot(slideId: string, atMs: number): Promise<HostOutcome<{ pngBase64: string }>> {
      const slide = resolveById(slideId)
      if (slide === null) {
        return { ok: false, code: 'slide-not-found', message: `no slide with id ${slideId}` }
      }
      if (capture === undefined) {
        return {
          ok: false,
          code: 'screenshot-unavailable',
          message: 'slide rendering is not available in this session',
        }
      }
      try {
        const pngBase64 = await capture(slide, atMs)
        return { ok: true, value: { pngBase64 } }
      } catch (error) {
        return { ok: false, code: 'internal', message: `screenshot failed: ${String(error)}` }
      }
    },
  }
}
