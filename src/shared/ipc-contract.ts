/**
 * The single source of truth for the renderer <-> main wire.
 *
 * `src/shared` is imported by all three build targets and must stay
 * dependency-free: types and pure helpers only.
 *
 * M0.3 stub — channels are declared, payloads land with their features.
 */

/** Request/response channels, invoked with `ipcRenderer.invoke` only. */
export type IpcRequests = {
  'app:ping': { req: Record<string, never>; res: { pong: true } }
}

/** One-way main -> renderer events, delivered on this fixed allow-list. */
export type IpcEvents = {
  'app:menu': { action: string }
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
