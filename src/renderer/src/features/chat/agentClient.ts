/**
 * The renderer's one accessor for the agent bridge — `window.sloodge.agent`, narrowed at runtime.
 *
 * Same discipline as `host/bridge.ts`'s `getBridge`: the preload surface is optional (a browser
 * host, or a preload older than this renderer, may not expose it), so consumers must check rather
 * than destructure. Returning `undefined` outside Electron is what lets the chat panel fall back to
 * its no-bridge state instead of throwing at module scope and blanking the window.
 */

import type { AgentBridge } from '../../../../preload/agentBridge'
import { getBridge } from '../../host/bridge'

/** The agent bridge, or `undefined` when this renderer is not running inside Electron. */
export function getAgentBridge(): AgentBridge | undefined {
  return getBridge()?.agent
}
