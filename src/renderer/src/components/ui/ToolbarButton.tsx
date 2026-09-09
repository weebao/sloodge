/**
 * A square glyph button in a toolbar row (ui-design-audit.md §5.6): `Button`'s `subtle` variant at
 * the one control size the whole app uses — `h-control w-control` = 28px = Helium's
 * `kToolbarButtonHeight` and the `h-7` the format bar already draws.
 *
 * Separate from `Button` rather than a sixth variant because its contract is different: it is always
 * icon- or glyph-only, so `label` is **required** and becomes `aria-label` — the audit's
 * accessibility punch-list found unlabelled glyph buttons on three surfaces, and a variant flag
 * cannot make a prop mandatory.
 *
 * **Roving-tabindex ready**: a toolbar that adopts the pattern owns which of its buttons is
 * tabbable, so `tabIndex` passes straight through and is not defaulted here. Left alone, every
 * button is tabbable — today's behaviour, unchanged until a surface opts in.
 */

import { type ButtonHTMLAttributes, type JSX, type ReactNode } from 'react'
import { FOCUS_RING } from './focusRing'

export type ToolbarButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'aria-label'
> & {
  /** Announced name. Required: this button never carries visible text. */
  readonly label: string
  /** Drawn state — a pressed toolbar toggle also sets `aria-pressed`, never colour alone. */
  readonly pressed?: boolean
  readonly children: ReactNode
}

const BASE =
  'inline-flex h-control w-control shrink-0 cursor-pointer items-center justify-center rounded-control leading-none text-text hover:bg-hover active:bg-pressed disabled:cursor-default disabled:opacity-50'

export function ToolbarButton({
  label,
  pressed,
  children,
  ...rest
}: ToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
      className={`${BASE} ${pressed === true ? 'bg-pressed' : ''} ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}
