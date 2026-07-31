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
export const IPC_REQUEST_CHANNELS = ['app:ping'] as const satisfies readonly IpcRequestChannel[]

export const IPC_EVENT_CHANNELS = [MENU_EVENT_CHANNEL] as const satisfies readonly IpcEventChannel[]

export function isIpcRequestChannel(value: string): value is IpcRequestChannel {
  return (IPC_REQUEST_CHANNELS as readonly string[]).includes(value)
}

export function isIpcEventChannel(value: string): value is IpcEventChannel {
  return (IPC_EVENT_CHANNELS as readonly string[]).includes(value)
}
