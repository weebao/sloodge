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
  makeHittestRequest,
  parseFrameMessage,
  SL_HITTEST,
  type SlHit,
} from '../../../../shared/design/bridge-protocol'

export type HitMode = 'hover' | 'select'

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
}

export function useDesignBridge(options: DesignBridgeOptions): DesignBridgeApi {
  const { frameRef, slideId, enabled, onHit } = options

  const nextId = useRef(createEnvelopeIdSource())
  // Correlates a response back to the mode that asked for it (the response payload does not carry
  // mode), and lets stale hover responses be dropped once a newer one has been sent.
  const pending = useRef(new Map<number, HitMode>())
  const latestHover = useRef(0)

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
    const handler = (event: MessageEvent): void => {
      const frameWindow = frameRef.current?.contentWindow ?? null
      if (!isMessageFromFrame(event, frameWindow)) return
      const message = parseFrameMessage(event.data, slideId)
      if (message === null) return
      if (message.dir !== 'res' || message.type !== SL_HITTEST) return

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
    }
  }, [enabled, slideId, frameRef])

  const requestHit = useCallback<DesignBridgeApi['requestHit']>(
    (x, y, mode, alt) => {
      const frameWindow = frameRef.current?.contentWindow
      if (!frameWindow) return
      const id = nextId.current()
      pending.current.set(id, mode)
      if (mode === 'hover') latestHover.current = id
      frameWindow.postMessage(makeHittestRequest(id, slideId, { x, y, mode, alt }), '*')
    },
    [frameRef, slideId],
  )

  return { requestHit }
}
