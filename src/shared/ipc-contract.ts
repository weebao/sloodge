/**
 * The single source of truth for the renderer <-> main wire.
 *
 * `src/shared` is imported by all three build targets and must stay
 * dependency-free: types and pure helpers only.
 *
 * M0.3 stub — channels are declared, payloads land with their features.
 */

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

/** Request/response channels, invoked with `ipcRenderer.invoke` only. */
export type IpcRequests = {
  'app:ping': { req: Record<string, never>; res: { pong: true } }
}

/** One-way main -> renderer events, delivered on this fixed allow-list. */
export type IpcEvents = {
  'app:menu': MenuAction
}

export type IpcRequestChannel = keyof IpcRequests
export type IpcEventChannel = keyof IpcEvents

export type IpcRequestPayload<C extends IpcRequestChannel> = IpcRequests[C]['req']
export type IpcResponsePayload<C extends IpcRequestChannel> = IpcRequests[C]['res']
export type IpcEventPayload<C extends IpcEventChannel> = IpcEvents[C]

/**
 * Runtime allow-lists. The preload's subscribe/invoke helpers refuse any
 * channel not present here, so this array is load-bearing, not documentation.
 */
export const IPC_REQUEST_CHANNELS = ['app:ping'] as const satisfies readonly IpcRequestChannel[]

export const IPC_EVENT_CHANNELS = ['app:menu'] as const satisfies readonly IpcEventChannel[]

export function isIpcRequestChannel(value: string): value is IpcRequestChannel {
  return (IPC_REQUEST_CHANNELS as readonly string[]).includes(value)
}

export function isIpcEventChannel(value: string): value is IpcEventChannel {
  return (IPC_EVENT_CHANNELS as readonly string[]).includes(value)
}
