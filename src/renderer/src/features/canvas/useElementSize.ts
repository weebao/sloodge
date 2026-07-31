import { useCallback, useState } from 'react'
import type { Size } from './slideFit'

/**
 * Measure an element's content box and keep the measurement current as it resizes.
 *
 * The canvas cannot fit a slide with CSS alone: the frame is a fixed 1280x720 box scaled by a
 * transform, and a transform factor is a number, not a layout rule — so the host has to know how
 * much room it has. `ResizeObserver` rather than a window `resize` listener because the canvas
 * also changes size when the chat panel or the rail does, with no window event at all.
 *
 * Returns a **callback ref**, not an object ref: a ref object's `.current` is populated after the
 * commit with no re-render, so a component holding one measures nothing on its first paint and
 * never learns that the node arrived. React 19 lets a callback ref return its own cleanup, which
 * is what disconnects the observer when the node is swapped or unmounted.
 */
export function useElementSize<T extends HTMLElement>(): [(node: T) => () => void, Size] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  const ref = useCallback((node: T) => {
    const measure = (): void => {
      const rect = node.getBoundingClientRect()
      // Bail on an unchanged measurement: ResizeObserver fires for sub-pixel reflows the scale
      // factor would not notice, and every accepted state update re-renders the live frames.
      setSize((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      )
    }

    measure()

    // happy-dom (and any non-browser host) has no ResizeObserver. The single mount-time
    // measurement above still applies, so tests and SSR-like environments degrade to a static fit
    // rather than throwing.
    if (typeof ResizeObserver === 'undefined') return () => undefined

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])

  return [ref, size]
}
