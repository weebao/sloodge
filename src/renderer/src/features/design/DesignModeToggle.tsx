/**
 * The Design Mode switch — M3.11's answer to "the current state is not obvious and the control is
 * easy to miss".
 *
 * ## Why it lives in `AppShell`, not the toolbar
 *
 * Through M3.10 this control sat at the right end of `FormatBar`, styled as an accent button whose
 * only "off" signal was being a slightly paler shade of the same accent. Two things were wrong with
 * that, and both are fixed here.
 *
 * **Placement.** The toolbar row is a *tab panel*: M6.1 turns the strip above it into a real tablist
 * whose selection swaps the row's contents, including contextually — selecting a shape jumps to a
 * Shape Format tab. A Design Mode control inside that row is therefore reachable only on some tabs,
 * and would vanish exactly when the user is mid-manipulation. Worse, the keyboard fallback is not a
 * fallback: `Ctrl/⌘+D` is a `window` listener in the host document, and key events raised inside the
 * slide iframe never reach it — so with focus in the frame and the button hidden there would be *no*
 * way to leave Design Mode and interact with a live slide. This component is rendered by `AppShell`
 * as persistent chrome so no ribbon state can take it away.
 *
 * **Legibility.** It is a `role="switch"` with its state spelled out in words ("On"/"Off") rather
 * than encoded in a fill colour, so the mode is readable at a glance and by a screen reader without
 * hovering anything. The `title` says what turning it *off* buys, because that is the non-obvious
 * half: sloodge slides can contain live JS — charts, hover states, click-throughs — and Design Mode
 * deliberately freezes them so selection is stable (§2.1). Turning it off is how you play with a
 * slide, which no affordance previously explained.
 */

import type { JSX } from 'react'
import { useDesignStore } from './designStore'

export function DesignModeToggle(): JSX.Element {
  const enabled = useDesignStore((state) => state.enabled)
  const toggle = useDesignStore((state) => state.toggle)

  return (
    <div className="flex shrink-0 items-center gap-2 border-l border-chrome-line px-3 dark:border-ink-line">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={toggle}
        title={
          enabled
            ? 'Design Mode is on — click text to select and edit it. Turn it off (Ctrl/⌘+D) to interact with a live slide.'
            : 'Design Mode is off — the slide is live and interactive. Turn it on (Ctrl/⌘+D) to select and edit elements.'
        }
        className="inline-flex h-7 items-center gap-2 rounded border border-chrome-line bg-white px-2 text-[13px] font-medium text-shell-fg transition-colors hover:bg-chrome-alt focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:border-ink-line dark:bg-ink-alt dark:text-ink-fg dark:hover:bg-ink-line"
      >
        <span aria-hidden="true" className={enabled ? 'text-accent' : 'text-chrome-muted'}>
          ✦
        </span>
        Design Mode
        {/* The state, in words. A colour alone is not a state indicator. */}
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
            enabled
              ? 'bg-accent text-white'
              : 'bg-chrome-line text-chrome-muted dark:bg-ink-line dark:text-ink-muted'
          }`}
        >
          {enabled ? 'On' : 'Off'}
        </span>
      </button>
    </div>
  )
}
