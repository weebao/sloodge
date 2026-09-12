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
 *
 * ## Drawn with the primitives
 *
 * The control is `Button`'s `secondary` variant — a standalone control on the toolbar row, so it has
 * an edge at rest (`line-strong`, 3.95 / 3.22:1 on `surface-raised`) and the one focus ring, which the
 * primitive owns (ui-design-audit.md §5.6, rule R6). The glyph is a `currentColor` SVG rather than
 * the `✦` character, coloured by role — `accent` when on, `text-muted` when idle, both mode-swapping
 * tokens, so the 2.36:1 dark glyph M8b.1a patched with a `dark:` twin cannot come back by omission.
 */

import type { JSX } from 'react'
import { Button } from '../../components/ui'
import { useDesignStore } from './designStore'

/** A four-point star at the toolbar icon size (ui-design-audit.md §4.1 item 4). */
function SparkIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
      <path
        d="M8 1.75C8.55 5.35 10.65 7.45 14.25 8 10.65 8.55 8.55 10.65 8 14.25 7.45 10.65 5.35 8.55 1.75 8 5.35 7.45 7.45 5.35 8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function DesignModeToggle(): JSX.Element {
  const enabled = useDesignStore((state) => state.enabled)
  const toggle = useDesignStore((state) => state.toggle)

  return (
    <div className="flex shrink-0 items-center border-l border-line px-3">
      <Button
        variant="secondary"
        role="switch"
        aria-checked={enabled}
        onClick={toggle}
        title={
          enabled
            ? 'Design Mode is on — click text to select and edit it. Turn it off (Ctrl/⌘+D) to interact with a live slide.'
            : 'Design Mode is off — the slide is live and interactive. Turn it on (Ctrl/⌘+D) to select and edit elements.'
        }
      >
        <span aria-hidden="true" className={enabled ? 'text-accent' : 'text-text-muted'}>
          <SparkIcon />
        </span>
        Design Mode
        {/* The state, in words. A colour alone is not a state indicator. On is the accent fill with
            `on-fill` text (5.19 / 5.83:1); Off is a sunken well with muted text (5.62 / 6.77:1). */}
        <span
          className={`rounded-control px-1.5 py-0.5 text-caption font-semibold tracking-caps uppercase ${
            enabled ? 'bg-accent text-on-fill' : 'bg-surface-sunken text-text-muted'
          }`}
        >
          {enabled ? 'On' : 'Off'}
        </span>
      </Button>
    </div>
  )
}
