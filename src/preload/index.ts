import { contextBridge } from 'electron'

/**
 * The entire renderer-visible surface. Every future capability (doc, agent,
 * export, present) hangs off this one object — see src/shared/ipc-contract.ts.
 *
 * M0.3: intentionally empty apart from a version marker.
 */
const api = {
  version: '0.0.0',
} as const

export type SloodgeApi = typeof api

contextBridge.exposeInMainWorld('sloodge', api)
