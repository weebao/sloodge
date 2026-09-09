/**
 * The one button (ui-design-audit.md §5.6). Five variants, no sixth: the audit counted eleven
 * distinct button recipes across the shipped surfaces, which is how `bg-neutral-900` ended up next
 * to `bg-accent` on two dialogs that do the same thing.
 *
 * Variants are roles, not looks — `primary` is the one action a surface wants, `danger` destroys
 * something, `link` is inline in a sentence. `secondary` and `subtle` differ only in whether the
 * control has an edge at rest: `secondary` is a standalone control on a panel, `subtle` is one of a
 * row of them in a toolbar, where fourteen visible borders would be noise.
 *
 * `hover:opacity-90` on the filled variants rather than a second fill token: an accent that is
 * lifted in dark mode (`oklch(0.67 …)`) has no darker sibling declared, and inventing one per
 * variant is exactly the alpha-improvisation rule R3 forbids.
 *
 * Every interactive primitive owns its focus ring and no surface writes `focus-visible:` itself
 * (R6) — see `focusRing.ts`.
 */

import { type ButtonHTMLAttributes, type JSX, type ReactNode } from 'react'
import { FOCUS_RING } from './focusRing'

export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'danger' | 'link'

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  readonly variant?: ButtonVariant
  readonly children: ReactNode
}

const BASE =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 text-ui font-medium disabled:cursor-default disabled:opacity-50'

const VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary: 'h-control rounded-control px-3 bg-accent text-on-fill hover:opacity-90',
  secondary:
    'h-control rounded-control px-3 bg-surface-raised border border-line-strong text-text hover:bg-hover active:bg-pressed',
  subtle: 'h-control rounded-control px-2 text-text hover:bg-hover active:bg-pressed',
  danger: 'h-control rounded-control px-3 bg-danger text-on-fill hover:opacity-90',
  link: 'rounded-control text-accent underline underline-offset-2 hover:opacity-90',
}

export function Button({ variant = 'secondary', children, ...rest }: ButtonProps): JSX.Element {
  return (
    // `type="button"` by default and overridable: a bare <button> inside a <form> submits it, which
    // is the defect this primitive exists to stop repeating.
    <button type="button" {...rest} className={`${BASE} ${VARIANT[variant]} ${FOCUS_RING}`}>
      {children}
    </button>
  )
}
