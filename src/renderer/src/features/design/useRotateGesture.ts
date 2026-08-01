/**
 * The pointer-gesture half of rotate — M3.6's sibling to `useDragGesture`. It owns the mechanics of
 * one rotation: on `pointerdown` capture the selection centre (client px), the pointer's start angle
 * about it, and the element's rotation at gesture start; follow the pointer with a rAF-throttled live
 * preview angle; on `pointerup` hand the *committed* angle to `onCommit` — exactly once (§7.2: a
 * whole rotation is one undo step, guaranteed structurally because intermediate frames only ever call
 * `setPreviewAngle`, never the document store). `Esc`/`pointercancel` end with no commit.
 *
 * All the angle math is the pure `rotate.ts` layer; this hook is thin wiring in the exact shape
 * `useDragGesture` is, for the same reasons — lifetime-scoped window listeners gated on an active
 * ref, so a single unmount cleanup removes what a single mount added and an idle overlay pays
 * nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Point } from '../../../../shared/design/overlay-geometry'
import {
  pointerAngleDeg,
  snapRotation,
  type RotateModifiers,
} from '../../../../shared/design/rotate'

/** A live rotation in progress: the pivot, the pointer's start angle, and the start rotation. */
interface ActiveRotate {
  readonly centre: Point
  readonly startPointerDeg: number
  readonly startRotation: number
}

export interface RotateGestureOptions {
  /** The element's current rotation in degrees (read from source), a gesture's starting point. */
  readonly rotation: number
  /** The selection centre in client px at `pointerdown` — the pivot. `null` disables the gesture. */
  readonly getCentre: () => Point | null
  /** Called once per gesture on `pointerup`, with the start and committed (snapped) angles. */
  readonly onCommit: (startDeg: number, nextDeg: number) => void
}

export interface RotateGestureApi {
  /** Begin a rotation from a `pointerdown` on the rotation handle. */
  readonly startRotate: (event: React.PointerEvent) => void
  /** The live preview angle while rotating, or `null` when idle — the overlay renders this instead. */
  readonly previewAngle: number | null
  /** Whether a rotation is in progress. */
  readonly isRotating: boolean
}

function modsOf(event: PointerEvent): RotateModifiers {
  return { shift: event.shiftKey, alt: event.altKey }
}

export function useRotateGesture(options: RotateGestureOptions): RotateGestureApi {
  const { rotation, getCentre, onCommit } = options

  const active = useRef<ActiveRotate | null>(null)
  const [previewAngle, setPreviewAngle] = useState<number | null>(null)
  const [rotating, setRotating] = useState(false)

  // Refs so the lifetime-scoped listeners read the latest values without being reinstalled.
  const rotationRef = useRef(rotation)
  rotationRef.current = rotation
  const getCentreRef = useRef(getCentre)
  getCentreRef.current = getCentre
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  useEffect(() => {
    const raf = { id: 0 }
    const queued = { event: null as PointerEvent | null }

    const angleFor = (event: PointerEvent): number | null => {
      const drag = active.current
      if (drag === null) return null
      // The swept angle is measured against the pointer angle stored at `pointerdown`, so the result
      // is independent of where on the handle the pointer grabbed (see `rotate.ts`).
      const swept =
        pointerAngleDeg(drag.centre, { x: event.clientX, y: event.clientY }) - drag.startPointerDeg
      return snapRotation(drag.startRotation + swept, modsOf(event))
    }

    const endGesture = (): void => {
      if (raf.id !== 0) {
        cancelAnimationFrame(raf.id)
        raf.id = 0
      }
      active.current = null
      queued.event = null
      setPreviewAngle(null)
      setRotating(false)
    }

    const onMove = (event: PointerEvent): void => {
      if (active.current === null) return
      queued.event = event
      if (raf.id !== 0) return
      raf.id = requestAnimationFrame(() => {
        raf.id = 0
        const latest = queued.event
        if (latest === null) return
        const angle = angleFor(latest)
        if (angle !== null) setPreviewAngle(angle)
      })
    }

    const onUp = (event: PointerEvent): void => {
      const drag = active.current
      if (drag === null) return
      const angle = angleFor(event)
      const start = drag.startRotation
      endGesture()
      if (angle !== null) onCommitRef.current(start, angle)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (active.current === null) return
      if (event.key === 'Escape') {
        event.preventDefault()
        endGesture()
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', endGesture)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', endGesture)
      window.removeEventListener('keydown', onKey)
      if (raf.id !== 0) cancelAnimationFrame(raf.id)
    }
  }, [])

  const startRotate = useCallback((event: React.PointerEvent): void => {
    const centre = getCentreRef.current()
    if (centre === null) return
    event.preventDefault()
    event.stopPropagation()
    active.current = {
      centre,
      startPointerDeg: pointerAngleDeg(centre, { x: event.clientX, y: event.clientY }),
      startRotation: rotationRef.current,
    }
    setRotating(true)
  }, [])

  return { startRotate, previewAngle, isRotating: rotating }
}
