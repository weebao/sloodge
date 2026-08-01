/**
 * `SlideToolHost` over the M2.6 reconciliation seam — the bridge between the pure `mcp__slides__*`
 * handlers (`src/shared/agent/slide-tools.ts`) and the *authoritative renderer deck*.
 *
 * Before M2.6 this host owned a `DocumentHistory` of its own and mutated it directly. That made an
 * agent edit undoable at *that* history — but the shipped app is renderer-authoritative (the single
 * `DocumentHistory` lives in `deckStore`, M1.3/M1.4), so a second history in main would have been a
 * divergent deck the user's Ctrl/⌘+Z never sees. Now every mutating method builds a `DocCommand`
 * tagged `origin: agent` and hands it to a `DeckEditor`, which routes it into the *renderer's* history
 * via `history.apply` (see `deck-editor.ts` / `agent-edit.ts`). The renderer stays the single source
 * of truth; the agent edit lands on the same undo stack as a manual one; Ctrl/⌘+Z reverses it in one
 * step (50-agent-integration.md §6, 10-architecture.md §5).
 *
 * Reads (`resolve`/`list`/`count`) read the same authoritative deck through `editor.snapshot()`, so
 * the agent always sees current state — including its own just-applied edits. Nothing here reaches
 * into a deck directly, writes a file, or reads outside the document: the tool server's entire
 * mutation surface is these commands, which is what confines the agent to the document sandbox (§7).
 *
 * `electron`-free and injectable: it takes a `DeckEditor` (an in-process one over a `DocumentHistory`
 * in tests, an IPC-backed one in production) and an optional screenshot capturer. A renderer that
 * went away mid-call surfaces as `renderer-unavailable` — a typed error the model can act on, never a
 * hang (M2.1 lifecycle discipline; the `DeckEditor` enforces the no-hang guarantee).
 *
 * ## Deferred: the real screenshot render
 *
 * `screenshot` delegates to an injected `capture` function. Wiring that to an offscreen
 * `BrowserWindow` + `webContents.capturePage()` (§6, §17) depends on the renderer surface and is
 * **deliberately out of this milestone** — a host constructed without a capturer returns
 * `screenshot-unavailable`.
 */

import {
  createSlideEntry,
  getSlide,
  indexOfSlide,
  slideCount,
  slidesInOrder,
} from '../../shared/document/deck'
import type { DocCommand } from '../../shared/document/commands'
import type { AgentDeckSnapshot, AgentEditErrorCode } from '../../shared/document/agent-edit'
import type { DeckManifest } from '../../shared/document/types'
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
import type { DeckEditor } from './deck-editor'

/** Renders a resolved slide to a base64 PNG. Wiring to the offscreen renderer is deferred (§17). */
export type SlideScreenshotFn = (slide: ResolvedSlide, atMs: number) => Promise<string>

export type DeckToolHostDeps = {
  /** The authoritative deck, reached over IPC (production) or in-process (tests). */
  readonly editor: DeckEditor
  /** The conversation this host serves — recorded on `origin` for agent-tagged undo entries. */
  readonly sessionId?: string
  /** Pushed after every successful mutation (§9). The live canvas/rail already re-render off the
   * renderer history apply; this is a seam for any main-side observer (cost meter, autosave). */
  readonly onChange?: () => void
  /** Offscreen render, injected. Absent → `screenshot` returns `screenshot-unavailable`. */
  readonly capture?: SlideScreenshotFn
  /** Injectable clock so created-entry timestamps are deterministic in tests. */
  readonly now?: () => number
}

/** Map an edit error from the reconciliation layer onto a host outcome the model can act on. */
function fromEditError<T>(
  code: AgentEditErrorCode,
  message: string,
): HostOutcome<T> & { ok: false } {
  const hostCode: HostErrorCode =
    code === 'slide-not-found'
      ? 'slide-not-found'
      : code === 'index-out-of-range'
        ? 'index-out-of-range'
        : code === 'renderer-unavailable'
          ? 'renderer-unavailable'
          : code === 'internal'
            ? 'internal'
            : 'invalid'
  return { ok: false, code: hostCode, message }
}

function resolveFromSnapshot(snapshot: AgentDeckSnapshot, ref: SlideRef): ResolvedSlide | null {
  const { manifest, slides, notes } = snapshot
  const resolveById = (id: string): ResolvedSlide | null => {
    const entry = getSlide(manifest, id)
    if (!entry) return null
    const index = indexOfSlide(manifest, id)
    if (index === -1) return null
    return {
      id: entry.id,
      index: index + 1,
      title: entry.title,
      notes: Object.hasOwn(notes, id) ? (notes[id] ?? null) : null,
      html: Object.hasOwn(slides, id) ? (slides[id] ?? '') : '',
      capabilities: entry.capabilities ?? ['static'],
    }
  }
  if (ref.slideId !== undefined) return resolveById(ref.slideId)
  if (ref.index !== undefined) {
    const id = manifest.slideOrder[ref.index - 1]
    return id === undefined ? null : resolveById(id)
  }
  return null
}

export function createDeckToolHost(deps: DeckToolHostDeps): SlideToolHost {
  const { editor, sessionId, onChange, capture } = deps
  const now = deps.now ?? Date.now
  const turnId = sessionId ?? 'agent'

  /** A snapshot or a typed failure — the read path's single point of renderer-liveness handling. */
  const readSnapshot = async (): Promise<
    | { ok: true; snapshot: AgentDeckSnapshot }
    | { ok: false; code: AgentEditErrorCode; message: string }
  > => editor.snapshot()

  return {
    async resolve(ref: SlideRef): Promise<ResolvedSlide | null> {
      const snap = await readSnapshot()
      return snap.ok ? resolveFromSnapshot(snap.snapshot, ref) : null
    },

    async list() {
      const snap = await readSnapshot()
      if (!snap.ok) return []
      return slidesInOrder(snap.snapshot.manifest).map((slide, i) => ({
        id: slide.id,
        index: i + 1,
        title: slide.title,
      }))
    },

    async count() {
      const snap = await readSnapshot()
      return snap.ok ? slideCount(snap.snapshot.manifest) : 0
    },

    async create(request: CreateSlideRequest) {
      const snap = await readSnapshot()
      if (!snap.ok) return fromEditError(snap.code, snap.message)
      const count = slideCount(snap.snapshot.manifest)
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
      const applied = await editor.apply([command], turnId, 'create_slide')
      if (!applied.ok) return fromEditError(applied.code, applied.message)
      const index = indexOfSlide(applied.snapshot.manifest, entry.id) + 1
      onChange?.()
      return { ok: true, value: { slideId: entry.id, index } }
    },

    async update(request: UpdateSlideRequest) {
      const snap = await readSnapshot()
      if (!snap.ok) return fromEditError(snap.code, snap.message)
      if (!getSlide(snap.snapshot.manifest, request.slideId)) {
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
      // Both commands ride one `apply`, so an html+notes edit is a single undo entry (undo-parity).
      const applied = await editor.apply(commands, turnId, 'update_slide')
      if (!applied.ok) return fromEditError(applied.code, applied.message)
      const index = indexOfSlide(applied.snapshot.manifest, request.slideId) + 1
      onChange?.()
      return { ok: true, value: { slideId: request.slideId, index, revision: applied.rev } }
    },

    async reorder(request: ReorderRequest) {
      const snap = await readSnapshot()
      if (!snap.ok) return fromEditError(snap.code, snap.message)
      const manifest: DeckManifest = snap.snapshot.manifest
      const count = slideCount(manifest)
      if (!getSlide(manifest, request.slideId)) {
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
      const applied = await editor.apply([command], turnId, 'reorder')
      if (!applied.ok) return fromEditError(applied.code, applied.message)
      onChange?.()
      return {
        ok: true,
        value: { order: slidesInOrder(applied.snapshot.manifest).map((s) => s.id) },
      }
    },

    async screenshot(slideId: string, atMs: number): Promise<HostOutcome<{ pngBase64: string }>> {
      const snap = await readSnapshot()
      const slide = snap.ok ? resolveFromSnapshot(snap.snapshot, { slideId }) : null
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
