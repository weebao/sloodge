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
 *    end of the dialog does not start scrolling the deck behind it.
 *
 * Escape closes from anywhere inside, on `keydown` and with `stopPropagation`, so the app-level
 * shortcut handlers (Design Mode's Escape-to-deselect, Present's Escape-to-exit) do not also fire.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
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

  if (!open) return null

  return createPortal(
    // The scrim is `role="presentation"`: it is a click target, not a landmark. Clicking it closes,
    // matching both shipped dialogs' existing behaviour.
    <div
      className="fixed inset-0 z-dialog flex items-center justify-center bg-scrim p-4"
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
        className="flex max-h-[85vh] w-112 max-w-[90vw] flex-col overflow-y-auto overscroll-contain rounded-overlay bg-surface-raised text-ui text-text shadow-overlay"
        onClick={stopPropagation}
      >
        <h2 id={titleId} className="shrink-0 px-4 pt-4 text-title font-semibold">
          {title}
        </h2>
        <div className="min-h-0 px-4 py-3">{children}</div>
        {footer === undefined ? null : (
          <div className="flex shrink-0 justify-end gap-2 px-4 pb-4">{footer}</div>
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
