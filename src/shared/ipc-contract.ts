/**
 * The single source of truth for the renderer <-> main wire.
 *
 * `src/shared` is imported by all three build targets and must stay
 * dependency-free: types and pure helpers only.
 *
 * M0.3 stub — channels are declared, payloads land with their features.
 */

import type { AgentEvent, ApiKeySetRequest, ApiKeyStatus, AgentSendRequest } from './agent/types'
import type { DeckUpdate } from './document/deck-update'
import type { AgentEditRequest } from './document/agent-edit'
import type { ExportPdfRequest, ExportPdfResponse } from './export/types'

/**
 * Native-menu action ids, and the single source of truth for them: the main
 * process builds the menu from this union and the renderer switches on it.
 *
 * `edit.undo` / `edit.redo` were deliberately *absent* through M0.4: Undo and
 * Redo were Electron `role:` items so the OS drove native undo in focused
 * inputs, and they never reached the renderer. M1.4 reinstates them, because a
 * role and a document-undo accelerator cannot both own CmdOrCtrl+Z. Electron
 * registers a menu item's accelerator with the OS (`registerAccelerator`
 * defaults to true), so a role would consume the chord before any renderer
 * keydown — document undo by keyboard would simply not exist in the shipped
 * app, invisibly to a test suite that runs in happy-dom and a recording that
 * runs in plain Chromium.
 *
 * So the menu owns the chord and forwards it, and the renderer decides what it
 * means: native text undo when an editable element has focus, document undo
 * otherwise — the rule 10-architecture.md §5 states, now enforced at the one
 * place the keystroke arrives. Cut/Copy/Paste/SelectAll stay roles; nothing
 * about the clipboard is ambiguous.
 */
export const MENU_ACTIONS = [
  'file.new',
  'file.open',
  'file.export.pptx',
  'file.export.pdf',
  'file.export.html',
  'edit.undo',
  'edit.redo',
] as const

export type MenuAction = (typeof MENU_ACTIONS)[number]

/** The two ids the renderer's edit dispatcher answers to. */
export type EditMenuAction = Extract<MenuAction, `edit.${string}`>

/**
 * Runtime guard for a value crossing the IPC boundary. The renderer must not
 * switch on a string it merely hopes is one of ours.
 */
export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === 'string' && (MENU_ACTIONS as readonly string[]).includes(value)
}

/**
 * Publish a slide document into main's `slide://` registry. The renderer sends the assembled,
 * CSP-wrapped HTML and gets back an opaque id; `slideDocumentUrl(id)` is the frame's `src`.
 *
 * Deliberately not "here is an id, store this under it": minting the id in main is what makes it
 * unguessable-by-construction rather than unguessable-if-the-renderer-remembers-to.
 */
export type SlidePublishRequest = { html: string }
export type SlidePublishResponse = { id: string }

/**
 * Drop a published document. Idempotent — `revoked: false` means the id was already gone (a
 * double-revoke, or a registry that was cleared when its window closed), which is not an error.
 */
export type SlideRevokeRequest = { id: string }
export type SlideRevokeResponse = { revoked: boolean }

/**
 * The agent surface (M2.1). The API key travels in via `agent:setKey` and can only ever be read back
 * masked (`ApiKeyStatus`) — the plaintext never returns toward the renderer (50-agent-integration.md
 * §4). Turns are driven by `agent:send` / `agent:interrupt`; assistant deltas, tool chips, usage and
 * typed errors stream back one-way on `agent:event`.
 */
export type AgentSetKeyResponse = { status: ApiKeyStatus }
export type AgentKeyStatusResponse = { status: ApiKeyStatus }
export type AgentSendResponse = { accepted: boolean }
export type AgentInterruptResponse = { interrupted: boolean }

/**
 * Present mode (M4.1). The renderer owns the presentation surface — it reuses the same `slide://`
 * frame delivery the editor canvas does, so there is no second render path and the sandbox + CSP
 * hold exactly as in edit view. What the renderer *cannot* do for itself is drive the OS window into
 * real, borderless fullscreen: `BrowserWindow.setFullScreen` lives in main. This one request is that
 * seam and nothing more. It is idempotent and reversible — `{ fullscreen: false }` restores the
 * editor chrome — and the response reports the window's actual state after the call so the renderer
 * never assumes a toggle it did not get (a headless/browser host has no window and reports `false`).
 */
export type PresentFullscreenRequest = { fullscreen: boolean }
export type PresentFullscreenResponse = { fullscreen: boolean }

/** Request/response channels, invoked with `ipcRenderer.invoke` only. */
export type IpcRequests = {
  'app:ping': { req: Record<string, never>; res: { pong: true } }
  'slide:publish': { req: SlidePublishRequest; res: SlidePublishResponse }
  'slide:revoke': { req: SlideRevokeRequest; res: SlideRevokeResponse }
  'agent:setKey': { req: ApiKeySetRequest; res: AgentSetKeyResponse }
  'agent:clearKey': { req: Record<string, never>; res: AgentKeyStatusResponse }
  'agent:keyStatus': { req: Record<string, never>; res: AgentKeyStatusResponse }
  'agent:send': { req: AgentSendRequest; res: AgentSendResponse }
  'agent:interrupt': { req: Record<string, never>; res: AgentInterruptResponse }
  'present:setFullscreen': { req: PresentFullscreenRequest; res: PresentFullscreenResponse }
  'file:exportPdf': { req: ExportPdfRequest; res: ExportPdfResponse }
}

/** One-way main -> renderer events, delivered on this fixed allow-list. */
export type IpcEvents = {
  'app:menu': MenuAction
  'agent:event': AgentEvent
  /**
   * A live deck snapshot pushed as the agent writes, so the canvas and rail hot-update mid-turn
   * (50-agent-integration.md §9). Independent of `agent:event` on purpose — a stalled chat stream
   * must never freeze the canvas (10-architecture.md §9 invariant 3).
   */
  'deck:updated': DeckUpdate
  /**
   * A single agent tool edit, sent main → renderer for the renderer to apply through its authoritative
   * `DocumentHistory` (M2.6). The renderer replies on `DECK_AGENT_EDIT_RESULT_CHANNEL`. This is the
   * agent-edit path that keeps undo-parity; `deck:updated` above is doc:open/full-reload only.
   */
  'deck:agentEdit': AgentEditRequest
}

export type IpcRequestChannel = keyof IpcRequests
export type IpcEventChannel = keyof IpcEvents

export type IpcRequestPayload<C extends IpcRequestChannel> = IpcRequests[C]['req']
export type IpcResponsePayload<C extends IpcRequestChannel> = IpcRequests[C]['res']
export type IpcEventPayload<C extends IpcEventChannel> = IpcEvents[C]

/**
 * The channel both ends of the menu hop must agree on.
 *
 * A constant rather than a string literal at each site because the two ends are
 * in different build targets: `main` sends and `preload` subscribes, nothing
 * links them at runtime, and a typo in either literal compiles, type-checks,
 * lints and ships — with the only symptom being that keyboard undo silently
 * stops working in the packaged app. `satisfies` ties it to `IpcEvents`, so
 * renaming the channel there is a compile error at every call site instead of a
 * silent divergence.
 */
export const MENU_EVENT_CHANNEL = 'app:menu' satisfies IpcEventChannel

/**
 * The slide-delivery channels, constants for the same reason `MENU_EVENT_CHANNEL` is one: main
 * registers the handler, preload invokes it, and nothing links the two literals at runtime. A typo
 * here compiles and ships, and the symptom would be every slide rendering blank in the packaged app
 * while every unit test — which never crosses a real IPC boundary — stays green.
 */
export const SLIDE_PUBLISH_CHANNEL = 'slide:publish' satisfies IpcRequestChannel
export const SLIDE_REVOKE_CHANNEL = 'slide:revoke' satisfies IpcRequestChannel

/**
 * The agent channels, constants for the same reason the slide ones are: main registers the handlers,
 * preload invokes/subscribes, and nothing links the two literals at runtime. `AGENT_EVENT_CHANNEL`
 * is the streaming path (main -> renderer); the four request channels are `ipcRenderer.invoke` only.
 */
export const AGENT_SET_KEY_CHANNEL = 'agent:setKey' satisfies IpcRequestChannel
export const AGENT_CLEAR_KEY_CHANNEL = 'agent:clearKey' satisfies IpcRequestChannel
export const AGENT_KEY_STATUS_CHANNEL = 'agent:keyStatus' satisfies IpcRequestChannel
export const AGENT_SEND_CHANNEL = 'agent:send' satisfies IpcRequestChannel
export const AGENT_INTERRUPT_CHANNEL = 'agent:interrupt' satisfies IpcRequestChannel
export const AGENT_EVENT_CHANNEL = 'agent:event' satisfies IpcEventChannel

/**
 * Present mode's fullscreen toggle (M4.1). A constant for the same reason the others are: main
 * registers the handler, preload invokes it, and a typo in either literal would compile and ship as
 * "Present opens but the window never goes fullscreen", invisible to a suite that never crosses a
 * real IPC boundary.
 */
export const PRESENT_SET_FULLSCREEN_CHANNEL = 'present:setFullscreen' satisfies IpcRequestChannel

/**
 * PDF export (M4.2). Main registers the handler, preload invokes it, and — like the others — a typo
 * in either literal would compile and ship as "Export as PDF does nothing", invisible to a suite that
 * never crosses a real IPC boundary. Main owns the save dialog and the file write, so the renderer
 * hands over slide HTML and gets back a report, never a filesystem path it could tamper with.
 */
export const FILE_EXPORT_PDF_CHANNEL = 'file:exportPdf' satisfies IpcRequestChannel

/**
 * The deck hot-update channel (§9). Main pushes a full deck snapshot after every agent-driven
 * mutation; the renderer adopts it into its deck store so the slides appear as they are written.
 */
export const DECK_UPDATED_CHANNEL = 'deck:updated' satisfies IpcEventChannel

/**
 * The M2.6 agent-edit reconciliation channels. Main sends one tool edit on `DECK_AGENT_EDIT_CHANNEL`
 * (main → renderer); the renderer applies it through its authoritative history and replies on
 * `DECK_AGENT_EDIT_RESULT_CHANNEL` (renderer → main, `ipcRenderer.send` / `ipcMain.on`, correlated by
 * `requestId`). The result channel is a renderer → main *send*, not an `invoke`, so it is not in
 * `IpcEvents` (which is main → renderer) — it is a bare constant both ends agree on.
 */
export const DECK_AGENT_EDIT_CHANNEL = 'deck:agentEdit' satisfies IpcEventChannel
export const DECK_AGENT_EDIT_RESULT_CHANNEL = 'deck:agentEditResult'

/**
 * Runtime allow-lists: the declaration of every channel that may cross, which
 * call sites are expected to honour.
 *
 * They are *not* enforcement, and the comment here used to claim they were —
 * there are no central subscribe/invoke helpers to refuse an unlisted channel,
 * and M1.4's first real channel subscribes directly. What actually enforces
 * agreement today is `MENU_EVENT_CHANNEL` above plus the `satisfies` clauses
 * below; the guards exist for values arriving as untyped strings. A future
 * preload helper that funnels every channel through `isIpcEventChannel` would
 * make these load-bearing, and is the right shape once there is more than one.
 */
export const IPC_REQUEST_CHANNELS = [
  'app:ping',
  SLIDE_PUBLISH_CHANNEL,
  SLIDE_REVOKE_CHANNEL,
  AGENT_SET_KEY_CHANNEL,
  AGENT_CLEAR_KEY_CHANNEL,
  AGENT_KEY_STATUS_CHANNEL,
  AGENT_SEND_CHANNEL,
  AGENT_INTERRUPT_CHANNEL,
  PRESENT_SET_FULLSCREEN_CHANNEL,
  FILE_EXPORT_PDF_CHANNEL,
] as const satisfies readonly IpcRequestChannel[]

export const IPC_EVENT_CHANNELS = [
  MENU_EVENT_CHANNEL,
  AGENT_EVENT_CHANNEL,
  DECK_UPDATED_CHANNEL,
  DECK_AGENT_EDIT_CHANNEL,
] as const satisfies readonly IpcEventChannel[]

export function isIpcRequestChannel(value: string): value is IpcRequestChannel {
  return (IPC_REQUEST_CHANNELS as readonly string[]).includes(value)
}

export function isIpcEventChannel(value: string): value is IpcEventChannel {
  return (IPC_EVENT_CHANNELS as readonly string[]).includes(value)
}
