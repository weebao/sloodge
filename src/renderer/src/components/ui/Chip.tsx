/**
 * A pill — a context attachment, a filter, a small count (ui-design-audit.md §5.6).
 *
 * `rounded-full` is one of the two shapes that survive the radius reset (§5.1 principle 5), and it
 * is reserved for exactly this and the HUD pills; a rounded *rectangle* is `rounded-control`.
 *
 * The `accent` tone is a tint, never a fill: `bg-accent-soft` with `text-text` on it measures
 * 15.03 / 10.03, whereas accent text on the same tint is 3.87 in dark and is what rule R4 forbids.
 * An interactive chip is a real `<button>` — `onRemove` renders the ✕ as a separately labelled
 * button rather than making the whole chip clickable, so "remove" is never the only thing a chip
 * can do.
 */

import { type JSX, type ReactNode } from 'react'
import { FOCUS_RING } from './focusRing'

export type ChipTone = 'neutral' | 'accent'

export type ChipProps = {
  readonly tone?: ChipTone
  /** Present ⇒ the chip is a button. */
  readonly onClick?: () => void
  /** Present ⇒ a labelled ✕ is drawn after the content. */
  readonly onRemove?: () => void
  /** Names the chip for the ✕'s accessible label ("Remove <label>"). */
  readonly label?: string
  readonly children: ReactNode
}

const BASE = 'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-caption'
const TONE: Readonly<Record<ChipTone, string>> = {
  neutral: 'bg-surface-sunken text-text',
  accent: 'bg-accent-soft text-text',
}

export function Chip({
  tone = 'neutral',
  onClick,
  onRemove,
  label,
  children,
}: ChipProps): JSX.Element {
  const body = <span className="truncate">{children}</span>
  const remove =
    onRemove === undefined ? null : (
      <button
        type="button"
        aria-label={label === undefined ? 'Remove' : `Remove ${label}`}
        onClick={onRemove}
        className={`shrink-0 cursor-pointer rounded-full px-0.5 leading-none hover:bg-hover ${FOCUS_RING}`}
      >
        ✕
      </button>
    )

  if (onClick !== undefined) {
    return (
      <span className={`${BASE} ${TONE[tone]}`}>
        <button
          type="button"
          onClick={onClick}
          className={`cursor-pointer truncate rounded-full ${FOCUS_RING}`}
        >
          {children}
        </button>
        {remove}
      </span>
    )
  }
  return (
    <span className={`${BASE} ${TONE[tone]}`}>
      {body}
      {remove}
    </span>
  )
}
