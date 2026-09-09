/**
 * A standing message about state — an import caveat, a budget warning, a refused edit
 * (ui-design-audit.md §5.6).
 *
 * **No status by colour alone.** The tone drives the tint and the border, but the icon slot and the
 * tone word are what actually carry the meaning: the icon is rendered visibly and the tone word goes
 * into an `sr-only` span, so the notice reads as "Warning: …" whether the user sees hue, sees no
 * hue, or hears the line. The audit's punch-list found three notices that were a coloured background
 * and nothing else.
 *
 * `role="status"` (polite), not `alert`: every use of this in the app is a caveat on something that
 * already happened, and an assertive region interrupts whatever the user is reading. A surface that
 * genuinely needs to interrupt passes `role="alert"` and says why in a comment.
 *
 * Body text is `text-text` on the `*-soft` tint (11.98–16.62 in both modes, census rows 35–37), not
 * the tone colour on its own tint, which would be a second reading surface to measure per tone.
 */

import { type JSX, type ReactNode } from 'react'

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger'

export type NoticeProps = {
  readonly tone?: NoticeTone
  /** Drawn before the text. A glyph or an SVG — the non-colour half of the status. */
  readonly icon?: ReactNode
  /** Overrides `role="status"` for the rare notice that must interrupt. */
  readonly role?: 'status' | 'alert'
  readonly children: ReactNode
}

const TONE: Readonly<Record<NoticeTone, { readonly klass: string; readonly word: string }>> = {
  info: { klass: 'bg-accent-soft border-accent', word: 'Note' },
  success: { klass: 'bg-success-soft border-success', word: 'Success' },
  warning: { klass: 'bg-warning-soft border-warning', word: 'Warning' },
  danger: { klass: 'bg-danger-soft border-danger', word: 'Error' },
}

const BASE = 'flex items-start gap-2 rounded-panel border px-2 py-1 text-ui text-text'

export function Notice({
  tone = 'info',
  icon,
  role = 'status',
  children,
}: NoticeProps): JSX.Element {
  return (
    <div role={role} className={`${BASE} ${TONE[tone].klass}`}>
      <span className="sr-only">{TONE[tone].word}: </span>
      {icon === undefined ? null : (
        <span aria-hidden="true" className="shrink-0 leading-none">
          {icon}
        </span>
      )}
      <span className="min-w-0">{children}</span>
    </div>
  )
}
