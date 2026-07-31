/**
 * The rail's right-click menu (20-ui-wireframes.md: "right-click context menu (duplicate/delete)").
 *
 * Hand-rolled, ~100 lines, because the alternative is a headless-menu dependency for two items and
 * this milestone's budget for new dependencies is zero. What that buys has to be paid for in
 * behaviour, so the four things a native menu does are all here: it takes focus, Escape and an
 * outside press dismiss it, the arrow keys walk it, and a disabled item is not focusable.
 *
 * It is positioned `fixed` at the pointer and flipped up when it would hang off the bottom of the
 * window — the rail scrolls, and a menu opened on the last thumbnail of a long deck would otherwise
 * render its Delete item past the edge of the screen.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react'

export type SlideContextMenuItem = {
  /** Stable key, and the `data-menu-item` hook tests select on. */
  id: string
  label: string
  disabled?: boolean
  onSelect: () => void
}

/**
 * Why the menu closed, because the answer decides where focus goes.
 *
 * `select` and `escape` are the user finishing with the menu, and the invoker gets focus back
 * (WAI-ARIA's menu-button pattern). `dismiss` — an outside press, or the window losing focus — is
 * the user going *somewhere else*, and pulling focus back to the rail would take it away from
 * whatever they just clicked.
 */
export type MenuCloseReason = 'select' | 'escape' | 'dismiss'

export type SlideContextMenuProps = {
  /** Viewport coordinates of the pointer that opened the menu. */
  x: number
  y: number
  label: string
  items: readonly SlideContextMenuItem[]
  onClose: (reason: MenuCloseReason) => void
}

export function SlideContextMenu({
  x,
  y,
  label,
  items,
  onClose,
}: SlideContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [top, setTop] = useState(y)

  // Flip before paint, so the menu is never seen in the wrong place. `getBoundingClientRect` is
  // read once per open, on an element that is already laid out.
  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return
    const height = element.getBoundingClientRect().height
    setTop(y + height > window.innerHeight ? Math.max(0, y - height) : y)
  }, [y])

  const style = useMemo(() => ({ left: `${String(x)}px`, top: `${String(top)}px` }), [x, top])

  // Focus the first item that can act on the deck: a menu that opens without focus leaves Escape
  // and the arrow keys going nowhere, and the keydown handler below only sees events from inside.
  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')
    first?.focus()
  }, [])

  // Pointer*down*, not click: a menu that survives until mouseup would swallow the press that was
  // meant to dismiss it. Capture phase, so a handler that stops propagation cannot strand it open.
  //
  // Scroll dismisses too, and it has to: the rail is `overflow-y-auto` while this is positioned at
  // fixed viewport coordinates, so a wheel over the rail slides the thumbnails out from under a
  // menu that stays put. It would still act on the slide it was opened on — but it would be
  // labelling a different one, which is a menu that lies.
  useEffect(() => {
    const dismiss = (): void => {
      onClose('dismiss')
    }
    const onPointerDown = (event: PointerEvent | MouseEvent): void => {
      const element = menuRef.current
      if (element && event.target instanceof Node && element.contains(event.target)) return
      dismiss()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('blur', dismiss)
    // Capture, because the scroller is a descendant of nothing this listener sits on: a scroll
    // event does not bubble past its own element, but it does capture from the window down.
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [onClose])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose('escape')
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const buttons = [
        ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
      ]
      if (buttons.length === 0) return
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      // Wraps, like every OS menu: `+ buttons.length` keeps the modulo positive going up.
      const next = (current + step + buttons.length) % buttons.length
      buttons[next]?.focus()
    },
    [onClose],
  )

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={handleKeyDown}
      className="fixed z-50 min-w-[140px] rounded border border-chrome-line bg-white py-1 text-[12px] shadow-lg dark:border-ink-line dark:bg-ink-alt"
    >
      {items.map((item) => (
        <MenuItem key={item.id} item={item} onClose={onClose} />
      ))}
    </div>
  )
}

function MenuItem({
  item,
  onClose,
}: {
  item: SlideContextMenuItem
  onClose: (reason: MenuCloseReason) => void
}): JSX.Element {
  const handleClick = useCallback(() => {
    // Close first: the action can delete the slide this menu describes, and a menu still on screen
    // would then be pointing at nothing.
    onClose('select')
    item.onSelect()
  }, [item, onClose])

  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item={item.id}
      disabled={item.disabled === true}
      onClick={handleClick}
      className="block w-full px-3 py-1 text-left text-shell-fg hover:bg-accent hover:text-white disabled:cursor-not-allowed disabled:text-chrome-muted disabled:hover:bg-transparent disabled:hover:text-chrome-muted dark:text-ink-fg dark:disabled:text-ink-muted"
    >
      {item.label}
    </button>
  )
}
