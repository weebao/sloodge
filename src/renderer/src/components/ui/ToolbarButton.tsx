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
 *
 * **`aria-label` and `aria-pressed` are applied after `{...rest}`, and that is the guard.** Both are
 * `Omit`ted from the passthrough, but the `Omit` is documentation rather than enforcement:
 * TypeScript does not excess-property-check a JSX attribute whose name is hyphenated, so
 * `<ToolbarButton label="Bold" aria-label="spoofed" aria-pressed />` compiles clean (measured on
 * this tree's `tsc`; a `bogusProp` on the same element errors, a hyphenated one does not), and a
 * spread is never checked either way. Ordering is what actually holds the invariant: `label` names
 * the button and `pressed` states it, whatever a caller supplies. `title` stays *before* the spread
 * because overriding the tooltip is legitimate — it is not the accessible name.
 */

import { type ButtonHTMLAttributes, type JSX, type ReactNode } from 'react'
import { FOCUS_RING } from './focusRing'

export type ToolbarButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'aria-label' | 'aria-labelledby' | 'aria-pressed'
> & {
  /** Announced name. Required: this button never carries visible text. */
  readonly label: string
  /**
   * Drawn state — a pressed toolbar toggle also sets `aria-pressed`, never colour alone. The only
   * way to set either: see the header on why the ordering, not the `Omit`, is what enforces that.
   */
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
      title={label}
      {...rest}
      aria-label={label}
      // `aria-labelledby` OUTRANKS `aria-label` in the accessible-name computation, so omitting it
      // and re-applying `aria-label` is not enough — review r2 measured a caller's `aria-labelledby`
      // winning on the shipped component behind a clean `tsc`. Clearing it after the spread is what
      // makes `label` the name, the same ordering guard the two attributes below rely on.
      aria-labelledby={undefined}
      aria-pressed={pressed}
      className={`${BASE} ${pressed === true ? 'bg-pressed' : ''} ${FOCUS_RING}`}
    >
      {children}
    </button>
  )
}
