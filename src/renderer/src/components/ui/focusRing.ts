/**
 * Rule R6 (ui-design-audit.md §5.2): **one focus-ring recipe in the whole app.**
 *
 * The audit found four spellings in the shipped tree — `focus:border-accent`,
 * `focus-visible:ring-2 ring-accent ring-offset-1`, `focus-visible:outline-accent`, and controls
 * with no ring at all — which is why the ring's contrast could not be reasoned about: a `ring` sits
 * *on* the control (its contrast partner is the control's own fill) while an `outline` with an offset
 * sits *outside* it (its partner is the surrounding surface). The 4.10 / 3.51 / 4.28 census rows
 * measure the second case, so the second case is the one the app draws.
 *
 * Exported as a string rather than written into each primitive so that the ring is one edit, and so
 * `focus-ring.test.tsx` can assert every interactive primitive carries *this* value — a per-file
 * copy would let one primitive drift while the test kept reading its own constant.
 *
 * `focus-visible:` on all three parts, not just the width: `outline-2` alone would paint a permanent
 * 2px outline (Tailwind v4 sets `outline-style` with the width), and `outline-focus` alone would set
 * a colour on an outline of width 0. The three move together or the ring is wrong.
 */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2'
