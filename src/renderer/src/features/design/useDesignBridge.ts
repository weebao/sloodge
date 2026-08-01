/**
 * The parent-side postMessage client — the thin renderer half of the bridge (§3 of
 * `.claude/plans/init/40-design-mode.md`). It owns the `message` listener and the `SL_HITTEST` send;
 * every judgement it makes about *what* a message means is delegated to the pure validators in
 * `bridge-protocol.ts`, so this file has almost nothing to test that those suites do not already
 * cover — which is the point of keeping the wiring thin (the iframe never executes under happy-dom,
 * so an integration test of this hook is impossible without a real Chromium).
 *
 * The two things it must get right are both borrowed, not reinvented:
 *  - **Source identity** — `isMessageFromFrame(event, contentWindow)`, never `event.origin`.
 *  - **Shape** — `parseFrameMessage(event.data, slideId)`, which also enforces the slide guard.
 *
 * A message that fails either is dropped silently. But note precisely what surviving both buys: the
 * message came from *this frame* and is well-formed — **not** that it came from the injected bridge
 * rather than the slide's co-resident author JS (same realm, identical `event.source`; see
 * `bridge-protocol.ts`'s "real trust boundary"). So `onHit` payloads are untrusted hints, which is
 * why this milestone routes them only into ephemeral, re-validatable selection state. Any future
 * feature that acts authoritatively on a hit (edit-on-select) must re-derive from the parent-owned
 * `sl-id → span` map and gate on the diff gate, not trust what arrives here.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import {
  createEnvelopeIdSource,
  isMessageFromFrame,
  makeElementsRequest,
  makeHittestRequest,
  parseFrameMessage,
  SL_ELEMENTS,
  SL_HITTEST,
  type SlHit,
} from '../../../../shared/design/bridge-protocol'

/**
 * How a hit-test response should be applied. `hover`/`select` are the plain outline/single-select
 * paths; `toggle` is shift-click multi-select (M3.7) — the wire request is still a `select`, and
 * only the parent's response handling differs, so the frame protocol is untouched.
 */
export type HitMode = 'hover' | 'select' | 'toggle'

export interface DesignBridgeOptions {
  /** The slide iframe. Its `contentWindow` is the only trusted message source. */
  readonly frameRef: RefObject<HTMLIFrameElement | null>
  /** The slide id the frame is showing; used to reject stale-frame messages. */
  readonly slideId: string
  /** The bridge arms its listener only while this is true. */
  readonly enabled: boolean
  /** Called for every accepted hit-test response, tagged with the mode that requested it. */
  readonly onHit: (hit: SlHit | null, mode: HitMode) => void
}

export interface DesignBridgeApi {
  /** Send a hit-test for a point in **frame (1280×720) coordinates**. No-op if the frame is gone. */
  readonly requestHit: (x: number, y: number, mode: HitMode, alt: boolean) => void
  /**
   * Ask the frame for every grabbable element (M3.7 marquee + smart-guide targets). The callback
   * fires once, with the elements as full hits in document order — or is dropped silently if the
   * frame is gone or never answers. No-op if the frame is unavailable.
   */
  readonly requestElements: (onElements: (hits: readonly SlHit[]) => void) => void
}

export function useDesignBridge(options: DesignBridgeOptions): DesignBridgeApi {
  const { frameRef, slideId, enabled, onHit } = options

  const nextId = useRef(createEnvelopeIdSource())
  // Correlates a response back to the mode that asked for it (the response payload does not carry
  // mode), and lets stale hover responses be dropped once a newer one has been sent.
  const pending = useRef(new Map<number, HitMode>())
  const latestHover = useRef(0)
  // Correlates an `SL_ELEMENTS` response to the one-shot callback that asked for it.
  const pendingElements = useRef(new Map<number, (hits: readonly SlHit[]) => void>())

  // A ref so the listener effect never re-subscribes just because the caller passed a fresh closure.
  const onHitRef = useRef(onHit)
  useEffect(() => {
    onHitRef.current = onHit
  }, [onHit])

  useEffect(() => {
    if (!enabled) return
    // Captured once so the cleanup clears the same map this effect populated, not whatever the ref
    // points at when React runs the cleanup (the ref identity is stable, so the two are the same
    // Map — but capturing states that intent and satisfies the hooks rule).
    const pendingMap = pending.current
    const pendingElementsMap = pendingElements.current
    const handler = (event: MessageEvent): void => {
      const frameWindow = frameRef.current?.contentWindow ?? null
      if (!isMessageFromFrame(event, frameWindow)) return
      const message = parseFrameMessage(event.data, slideId)
      if (message === null) return
      if (message.dir !== 'res') return

      if (message.type === SL_ELEMENTS) {
        const cb = pendingElementsMap.get(message.id)
        if (cb === undefined) return
        pendingElementsMap.delete(message.id)
        cb(message.payload)
        return
      }
      if (message.type !== SL_HITTEST) return

      const mode = pendingMap.get(message.id)
      if (mode === undefined) return
      pendingMap.delete(message.id)
      // Drop a hover response that a newer hover has already superseded — avoids the outline
      // flickering back to an older position when responses arrive out of order.
      if (mode === 'hover' && message.id < latestHover.current) return
      onHitRef.current(message.payload, mode)
    }
    window.addEventListener('message', handler)
    return () => {
      window.removeEventListener('message', handler)
      pendingMap.clear()
      pendingElementsMap.clear()
    }
  }, [enabled, slideId, frameRef])

  const requestHit = useCallback<DesignBridgeApi['requestHit']>(
    (x, y, mode, alt) => {
      const frameWindow = frameRef.current?.contentWindow
      if (!frameWindow) return
      const id = nextId.current()
      pending.current.set(id, mode)
      if (mode === 'hover') latestHover.current = id
      // A shift-click `toggle` asks the frame to hit-test exactly as a `select` does; the toggle
      // semantics live entirely in the parent's response handling, so the wire mode is `select`.
      const wireMode = mode === 'hover' ? 'hover' : 'select'
      frameWindow.postMessage(makeHittestRequest(id, slideId, { x, y, mode: wireMode, alt }), '*')
    },
    [frameRef, slideId],
  )

  const requestElements = useCallback<DesignBridgeApi['requestElements']>(
    (onElements) => {
      const frameWindow = frameRef.current?.contentWindow
      if (!frameWindow) return
      const id = nextId.current()
      pendingElements.current.set(id, onElements)
      frameWindow.postMessage(makeElementsRequest(id, slideId), '*')
    },
    [frameRef, slideId],
  )

  return { requestHit, requestElements }
}
