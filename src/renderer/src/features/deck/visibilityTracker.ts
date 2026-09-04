import { useEffect, useState, type RefObject } from 'react'

/**
 * One `IntersectionObserver` for the whole rail, shared by every card (M8.2).
 *
 * One observer rather than one per card because the rail is the place where per-slide cost
 * multiplies by deck length: a 1000-slide deck would otherwise construct 1000 observers, each
 * with its own root geometry. A single observer with a listener map costs one entry per card.
 *
 * The observer is created where it is used so that the global it reads is the host's — in the
 * component tests that is a fake the test installs to drive visibility by hand, since happy-dom's
 * `IntersectionObserver` is a stub that never fires.
 */
export type VisibilityTracker = {
  /** Start reporting `target`'s visibility; returns the matching unsubscribe. */
  observe: (target: Element, onChange: (visible: boolean) => void) => () => void
  disconnect: () => void
}

export function createVisibilityTracker(root: Element, rootMargin: string): VisibilityTracker {
  const listeners = new Map<Element, (visible: boolean) => void>()
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting)
    },
    { root, rootMargin },
  )
  return {
    observe: (target, onChange) => {
      listeners.set(target, onChange)
      observer.observe(target)
      return () => {
        listeners.delete(target)
        observer.unobserve(target)
      }
    },
    disconnect: () => {
      listeners.clear()
      observer.disconnect()
    },
  }
}

/**
 * Whether `ref`'s element is inside the tracker's window. `false` until the tracker exists and has
 * reported — a card is a placeholder until proven visible, never a live frame until proven hidden,
 * because the failure mode of the opposite default is the O(deck) mounting this milestone removes.
 */
export function useVisibility(
  tracker: VisibilityTracker | null,
  ref: RefObject<Element | null>,
): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const target = ref.current
    if (tracker === null || target === null) return undefined
    return tracker.observe(target, setVisible)
  }, [tracker, ref])
  return visible
}
