/**
 * The section label above a group of controls (ui-design-audit.md §5.6): 11px, uppercase, tracked,
 * muted. The audit found this same label spelled five ways across the inspector and the settings
 * tabs (`text-[11px] font-semibold uppercase tracking-wide text-chrome-muted` and four near-misses).
 *
 * It renders a real heading element, not a styled `<div>`: the inspector is a landmark a screen
 * reader user navigates by heading, and `level` is a prop because the correct level depends on the
 * surface's own outline, which a primitive cannot know.
 */

import { createElement, type JSX, type ReactNode } from 'react'

export type PanelHeadingProps = {
  /** Heading level in the surface's outline. Defaults to 3 — a section inside a panel. */
  readonly level?: 2 | 3 | 4
  readonly id?: string
  readonly children: ReactNode
}

const CLASS = 'text-caption font-semibold uppercase tracking-caps text-text-muted'

export function PanelHeading({ level = 3, id, children }: PanelHeadingProps): JSX.Element {
  return createElement(`h${level}`, { id, className: CLASS }, children)
}
