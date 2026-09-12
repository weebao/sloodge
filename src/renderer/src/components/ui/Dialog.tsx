/**
 * The modal dialog (ui-design-audit.md §5.6). The app shipped two hand-rolled overlays — the PPTX
 * fidelity dialog and Settings — and between them they were missing every part of the modal
 * contract: no Escape, no focus trap, no focus restore, and the shell behind them still reachable by
 * Tab and by screen-reader virtual cursor.
 *
 * Four decisions worth stating, because each one is a defect if reversed:
 *
 * 1. **It portals to `document.body`.** `inert` on `#sloodge-shell` is what actually takes the app
 *    behind the scrim out of the tab order and out of the accessibility tree — `aria-hidden` alone
 *    leaves it keyboard-reachable. A dialog rendered *inside* the shell would inert itself along
 *    with it, so the portal is not a styling convenience; it is what makes `inert` usable at all.
 *    Nesting is refcounted, so a confirm opened over another dialog does not release the shell when
 *    it closes — see `openDialogCount` below.
 * 2. **Focus is restored to the element that opened it**, captured on open rather than on mount, so
 *    a dialog re-opened from a different control returns to that control.
 * 3. **The trap wraps on Tab / Shift+Tab** over the dialog's own focusables, recomputed on each
 *    keypress — a list captured on open goes stale the moment the dialog's content changes, which
 *    Settings' tabs do on every click.
 * 4. **`overscroll-contain` on the scrollable body**, so a wheel or trackpad flick that reaches the
 *    end of the dialog does not start scrolling the deck behind it. The *body* is the scroll
 *    container, not the panel: the title and the footer's buttons stay put while a long tab
 *    scrolls under them (M8b.3 surface 4 moved it here — the first cut scrolled the whole card, so
 *    Settings' Close button scrolled away with the Budget copy).
 *
 * Escape closes from anywhere inside, on `keydown` and with `stopPropagation`, so the app-level
 * shortcut handlers (Design Mode's Escape-to-deselect, Present's Escape-to-exit) do not also fire.
 *
 * **Motion** (ui-design-direction.md §5.5, one of the four bridges the audit approved): the scrim
 * fades in over `duration-fast`; the panel arrives over `duration-base` from `opacity-0
 * translate-y-1.5 scale-98` via `@starting-style` (the `starting:` variant, so it plays once on
 * mount and never on a re-render); both leave over `duration-fast` — faster than they came. Every
 * duration is a token and the easing is the theme default (`--ease-out`), so the
 * `prefers-reduced-motion` block in `theme.css` is the only guard needed: it drops the transform
 * and keeps the fade. Exit needs the DOM to outlive `open` by one transition, which is what the
 * `closing` state below is for — derived during render, because by the time an effect ran the
 * closed render would already have unmounted the node there is to fade. The unmount waits on the
 * transitions the panel is actually running (`getAnimations()`), not on a timer copied from a
 * token this file cannot read: a test DOM, or a user agent that zeroed the duration, has none
 * running and unmounts at once, exactly as before the motion landed.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export type DialogProps = {
  readonly open: boolean
  /** Visible title. Also the dialog's accessible name. */
  readonly title: string
  readonly onClose: () => void
  /** Rendered in the footer, right-aligned — the surface supplies its own `Button`s. */
  readonly footer?: ReactNode
  readonly children: ReactNode
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const SCRIM =
  'fixed inset-0 z-dialog flex items-center justify-center bg-scrim p-4 transition-opacity duration-fast starting:opacity-0'
const PANEL =
  'flex max-h-[85vh] w-112 max-w-[90vw] flex-col rounded-overlay bg-surface-raised text-ui text-text shadow-overlay transition starting:opacity-0 starting:translate-y-1.5 starting:scale-98'
/** The exit frame. `duration-fast` replaces the entry duration rather than joining it: both are `transition-duration`, and the one that wins would be decided by stylesheet order, not by this string. */
const SCRIM_EXIT = 'pointer-events-none opacity-0'
const PANEL_EXIT = 'opacity-0 translate-y-1.5 scale-98'

/**
 * How many dialogs are open. `inert` is a property of the shell, not of any one dialog, so a boolean
 * set on open and cleared on close is released by the FIRST dialog to unmount: with a confirm open
 * over Settings, dismissing the confirm hands the app behind the still-painted scrim back to Tab and
 * back to the screen-reader virtual cursor — the exact state decision 1 above exists to prevent, and
 * silent, because the scrim looks identical either way. Module scope for the same reason the
 * attribute is: two `Dialog` instances have to agree about one element.
 */
let openDialogCount = 0

export function Dialog({
  open,
  title,
  onClose,
  footer,
  children,
}: DialogProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  // `closing` holds the DOM through the exit transition. Set from the `open` edge during render
  // (React's derive-from-props form), not in an effect — see the header.
  const [wasOpen, setWasOpen] = useState(open)
  const [closing, setClosing] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    setClosing(!open)
  }

  useEffect(() => {
    if (!open) return
    const restoreTo = document.activeElement
    const shell = document.getElementById('sloodge-shell')
    openDialogCount += 1
    shell?.setAttribute('inert', '')

    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel)?.focus()

    return () => {
      openDialogCount -= 1
      // Released by the LAST dialog to close, and before the focus restore below: focusing an
      // element inside an inert subtree silently does nothing, so the order is load-bearing.
      if (openDialogCount === 0) shell?.removeAttribute('inert')
      // Restoring only to an element still in the document: a dialog that unmounted because the
      // control that opened it went away must not throw, and must not steal focus to nowhere.
      if (restoreTo instanceof HTMLElement && restoreTo.isConnected) restoreTo.focus()
    }
  }, [open])

  // Unmount once the exit transitions the closing classes started have finished. `getAnimations()`
  // forces the style flush that creates them, so the list is complete on the first call; an empty
  // list means nothing is animating (no stylesheet, or a zeroed duration) and there is nothing to
  // wait for. `allSettled`, because a transition cancelled by a re-open rejects its `finished`.
  useEffect(() => {
    if (!closing) return
    const panel = panelRef.current
    const running = typeof panel?.getAnimations === 'function' ? panel.getAnimations() : []
    if (running.length === 0) {
      setClosing(false)
      return
    }
    let live = true
    void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
      if (live) setClosing(false)
    })
    return () => {
      live = false
    }
  }, [closing])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (panel === null) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  if (!open && !closing) return null
  const exiting = !open

  return createPortal(
    // The scrim is `role="presentation"`: it is a click target, not a landmark. Clicking it closes,
    // matching both shipped dialogs' existing behaviour. While exiting it is `inert` and takes no
    // pointer, so the 120ms of fade cannot be clicked, tabbed into or read — focus has already gone
    // back to the opener by then (the cleanup above ran when `open` fell).
    <div
      className={`${SCRIM} ${exiting ? SCRIM_EXIT : ''}`}
      inert={exiting}
      role="presentation"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${PANEL} ${exiting ? `duration-fast ${PANEL_EXIT}` : 'duration-base'}`}
        onClick={stopPropagation}
      >
        <h2 id={titleId} className="shrink-0 px-5 py-3 text-title font-semibold">
          {title}
        </h2>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 py-4">
          {children}
        </div>
        {footer === undefined ? null : (
          <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Declared once at module scope: an inline arrow would give the panel a new prop every render. */
function stopPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation()
}
