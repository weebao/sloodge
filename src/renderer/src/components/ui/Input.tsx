/**
 * The one text field (ui-design-audit.md §5.6). The audit measured the credential fields at
 * **1.00:1** — `bg-white` with a dark-mode twin naming `ink-bg`, a token that was never declared, so the field
 * was invisible against its own label (§3.1 U1). Two things fix that permanently and both live here:
 * the fill is `bg-field`, a role token that swaps by mode with no `dark:` variant to forget (R1),
 * and the edge is `border-line-strong`, the token chosen so a control border clears 3:1 on every
 * ground (census rows 40–43).
 *
 * `text-ui` explicitly rather than inherited: 13px is also the iOS zoom floor, and a field that
 * inherits from a `text-caption` ancestor would silently become an 11px input.
 */

import { type InputHTMLAttributes, type JSX } from 'react'
import { FOCUS_RING } from './focusRing'

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>

const BASE =
  'h-control w-full min-w-0 rounded-control border border-line-strong bg-field px-2 text-ui text-text placeholder:text-text-muted disabled:cursor-default disabled:opacity-50'

export function Input(props: InputProps): JSX.Element {
  return <input {...props} className={`${BASE} ${FOCUS_RING}`} />
}
