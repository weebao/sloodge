/**
 * A divider is **spacing, not a line** (ui-design-audit.md §5.6).
 *
 * The audit counted sixteen border-width spellings and a `w-px` habit: agents reach for a hairline
 * whenever two groups need separating, and the result is a toolbar drawn as a picket fence. Grouping
 * is done with space first; a `border-line` edge is for a *structural* boundary — a panel against
 * the canvas — and is written on the panel, not inserted between siblings.
 *
 * So this exports a gap class rather than a component: there is nothing to render, and a primitive
 * that rendered nothing would just be a slower way to reach for `w-px` again.
 *
 * Steps are the audit's allowed spacing set (§5.3): 4 / 8 / 12px.
 */

export type DividerSize = 'tight' | 'default' | 'loose'

const GAP: Readonly<Record<DividerSize, string>> = {
  tight: 'gap-1',
  default: 'gap-2',
  loose: 'gap-3',
}

/** The `gap-*` class a flex/grid row uses to separate two groups of controls. */
export function dividerGap(size: DividerSize = 'default'): string {
  return GAP[size]
}
