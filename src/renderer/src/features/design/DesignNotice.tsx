/**
 * The one place a refused text edit is explained (M3.11) — §9.3 of
 * `.claude/plans/init/40-design-mode.md`.
 *
 * It is rendered by `SlideCanvas`, not by `SelectionOverlay`, because the overlay is the wrong host
 * for it: two of the four exits that can refuse an edit — turning Design Mode off, and Present,
 * which forces it off — unmount the overlay in the same commit that starts the refusal, so a notice
 * owned by the overlay could never be shown for exactly the exits that most need it (round-8 minor:
 * an over-cap value exiting through `Enter` or `Esc` said so, through the toggle or Present said
 * nothing). The canvas outlives both, so the same sentence appears wherever the refusal happened.
 *
 * It does not auto-dismiss, deliberately (round-5 minor, upheld on review): the notice is the only
 * account of why an edit did not stick, and a timer that removed it would leave a user who looked
 * away with vanished work and no explanation. It has an explicit ✕, and a new caret clears it. The
 * ✕ is the glyph the `Chip` primitive's remove button draws, in the same recipe, so the two
 * dismiss affordances in the app are one shape.
 *
 * `SlideCanvas` owns the `aria-live="polite"` host this renders into, and its position with it: a
 * region inserted already carrying its text is commonly not announced, so it has to outlive the
 * notice. This element only paints.
 *
 * A second identical refusal deliberately changes nothing here — same text, same node, no
 * re-announcement (round-9 minor). The element has already snapped back to its stored text, which is
 * the feedback that the retry was refused too; this sentence is the standing explanation of why, and
 * a polite region re-reading a sentence that never left the screen is noise.
 */

import { useCallback, useEffect, type JSX } from 'react'
import { FOCUS_RING, Notice } from '../../components/ui'
import { useDesignStore } from './designStore'

export type DesignNoticeProps = {
  /** The slide on screen. A notice raised on any other one is stale and is dropped. */
  readonly slideId: string
}

export function DesignNotice({ slideId }: DesignNoticeProps): JSX.Element | null {
  const notice = useDesignStore((state) => state.notice)
  const setNotice = useDesignStore((state) => state.setNotice)
  const onDismiss = useCallback((): void => {
    setNotice(null)
  }, [setNotice])

  // Leaving the slide drops the notice rather than merely hiding it, or a there-and-back would bring
  // it up again against an element the user has since stopped thinking about (round-4). Dropping it
  // here rather than in `useTextEditing` covers the switch that happens while Design Mode is off,
  // where that hook is not mounted to see it.
  const stale = notice !== null && notice.slideId !== slideId
  useEffect(() => {
    if (stale) setNotice(null)
  }, [stale, setNotice])

  if (notice === null || stale) return null
  return (
    // The `Notice` primitive's warning tone (ui-design-audit.md §4.3 item 5): `warning-soft` fill,
    // `warning` edge, the ⚠ and the sr-only "Warning:" carrying the status without the colour. Its
    // default role is `status` rather than `alert`, matching the chat transcript's notice: the
    // element is intact and back to its stored text, so this is a caveat on what the user just did,
    // not a failure. `pointer-events-auto` on a wrapper, because the canvas's live-region host is
    // `pointer-events-none` so that an empty region never sits between the pointer and the overlay.
    <div className="pointer-events-auto">
      <Notice tone="warning" icon="⚠" data-testid="design-notice">
        <span className="flex items-center gap-2">
          <span>{notice.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className={`shrink-0 cursor-pointer rounded-full px-0.5 leading-none hover:bg-hover ${FOCUS_RING}`}
            onClick={onDismiss}
          >
            ✕
          </button>
        </span>
      </Notice>
    </div>
  )
}
