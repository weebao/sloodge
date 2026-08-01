/**
 * The parent-side `SL_INSPECT` client — the renderer half of the computed-styles bridge request
 * (§6.2 of `.claude/plans/init/40-design-mode.md`, M3.4). It is a sibling of `useDesignBridge`: the
 * frame is opaque-origin, so the only way to get `getComputedStyle` out of it is a `postMessage`
 * round-trip, and every judgement about *what* a reply means is delegated to the pure validators in
 * `bridge-protocol.ts` — the same `isMessageFromFrame` source-identity check and `parseFrameMessage`
 * shape+slide gate the rest of the bridge uses.
 *
 * It is deliberately a separate, tiny hook rather than more surface on `useDesignBridge`: the
 * property panel (where "Ask Claude about this element" lives) needs `inspect`, the overlay needs
 * `requestHit`, and the two live in different components. Each hook owns one `message` listener that
 * ignores messages it did not request (different pending map), so they coexist cleanly.
 *
 * As with `useDesignBridge`, an `SL_INSPECT` reply is an **untrusted hint** (a co-resident slide
 * script can forge a well-formed one). That is safe because the caller folds the computed styles/rect
 * into the bundle as inert informational context only — the bundle's authoritative field, the
 * element's source HTML, is re-derived from the parent-owned map, never from this reply (§2.2).
 * Because the iframe never executes under happy-dom, this wiring (like `useDesignBridge`) has no
 * unit test of its own; the pure protocol it leans on is exhaustively covered.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import {
  createEnvelopeIdSource,
  isMessageFromFrame,
  makeInspectRequest,
  parseFrameMessage,
  SL_INSPECT,
  type SlInspect,
} from '../../../../shared/design/bridge-protocol'

/** How long to wait for an `SL_INSPECT` reply before resolving `null` (a slow/unhealthy frame). */
const INSPECT_TIMEOUT_MS = 250

export interface ElementInspectOptions {
  readonly frameRef: RefObject<HTMLIFrameElement | null>
  readonly slideId: string
  /** The hook arms its listener only while this is true (Design Mode on for this slide). */
  readonly enabled: boolean
}

export interface ElementInspectApi {
  /**
   * Request the whitelisted computed styles + rect for `slId`. Resolves `null` when the frame is
   * gone, times out, or has no node for the id. The reply is an untrusted hint (see the header).
   */
  readonly inspect: (slId: string) => Promise<SlInspect | null>
}

interface Pending {
  readonly resolve: (value: SlInspect | null) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export function useElementInspect(options: ElementInspectOptions): ElementInspectApi {
  const { frameRef, slideId, enabled } = options
  const nextId = useRef(createEnvelopeIdSource())
  const pending = useRef(new Map<number, Pending>())

  useEffect(() => {
    if (!enabled) return
    const pendingMap = pending.current
    const handler = (event: MessageEvent): void => {
      const frameWindow = frameRef.current?.contentWindow ?? null
      if (!isMessageFromFrame(event, frameWindow)) return
      const message = parseFrameMessage(event.data, slideId)
      if (message === null) return
      if (message.dir !== 'res' || message.type !== SL_INSPECT) return
      const entry = pendingMap.get(message.id)
      if (entry === undefined) return
      pendingMap.delete(message.id)
      clearTimeout(entry.timer)
      entry.resolve(message.payload)
    }
    window.addEventListener('message', handler)
    return () => {
      window.removeEventListener('message', handler)
      for (const entry of pendingMap.values()) {
        clearTimeout(entry.timer)
        entry.resolve(null)
      }
      pendingMap.clear()
    }
  }, [enabled, slideId, frameRef])

  const inspect = useCallback<ElementInspectApi['inspect']>(
    (slId) =>
      new Promise<SlInspect | null>((resolve) => {
        const frameWindow = frameRef.current?.contentWindow
        if (!frameWindow) {
          resolve(null)
          return
        }
        const id = nextId.current()
        const timer = setTimeout(() => {
          pending.current.delete(id)
          resolve(null)
        }, INSPECT_TIMEOUT_MS)
        pending.current.set(id, { resolve, timer })
        frameWindow.postMessage(makeInspectRequest(id, slideId, { slId }), '*')
      }),
    [frameRef, slideId],
  )

  return { inspect }
}
