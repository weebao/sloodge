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
 * away with vanished work and no explanation. It has an explicit ✕, and a new caret clears it.
 */

import { useCallback, useEffect, type JSX } from 'react'
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
    // `status` rather than `alert`, matching the chat transcript's notice: the element is intact and
    // back to its stored text, so this is a caveat on what the user just did, not a failure.
    <div
      role="status"
      data-testid="design-notice"
      className="absolute bottom-9 left-1/2 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded bg-amber-600 px-2 py-1 text-[11px] leading-4 text-white"
    >
      <span>{notice.text}</span>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded px-1 hover:bg-black/20"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  )
}
