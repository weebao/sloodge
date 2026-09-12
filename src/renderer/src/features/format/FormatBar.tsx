import type { JSX, ReactNode } from 'react'
import { Button, ToolbarButton, dividerGap } from '../../components/ui'

/**
 * The formatting toolbar. Most buttons are still cosmetic (M0.4): they carry
 * `aria-disabled` so they still hover and focus, selects are plainly
 * `disabled` because a focusable-but-unusable select is a trap.
 *
 * Every glyph button is the `ToolbarButton` primitive; the two with a visible word (`Shape`,
 * `Image`) are `Button`'s `subtle` variant, which is the same recipe at the same 28px with room for
 * the label — `ToolbarButton` is glyph-only by contract (ui-design-audit.md §4.1 item 2, §5.6). The
 * groups are separated by space, never a hairline: the audit's `Divider` is a gap class, because a
 * toolbar drawn as a picket fence was the finding.
 *
 * **The Design Mode toggle deliberately does not live here** (M3.11). This row is a tab panel — M6.1
 * swaps its contents per ribbon tab, contextually — so a control placed here is reachable only on
 * some tabs. Design Mode is the switch that decides whether clicking the canvas selects or interacts,
 * and it has to be operable at all times, so it moved to `DesignModeToggle`, rendered as persistent
 * chrome by `AppShell`. See that file's header for the full argument.
 */

/**
 * A dead control says so in the user's language. "(not wired up yet)" was developer build-status
 * copy shipped to users (ui-design-direction.md §3.2 #13, §6 #10). The tooltip still has to say the
 * button does nothing: at rest it looks like every other button in the row, and the primitives draw
 * no `aria-disabled` state of their own.
 */
const UNAVAILABLE = ' — not available yet'

function ToolButton({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <ToolbarButton label={label} title={`${label}${UNAVAILABLE}`} aria-disabled="true">
      {children}
    </ToolbarButton>
  )
}

function LabelledToolButton({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <Button
      variant="subtle"
      aria-label={label}
      title={`${label}${UNAVAILABLE}`}
      aria-disabled="true"
    >
      {children}
    </Button>
  )
}

const SELECT_BASE =
  'h-control rounded-control border border-line-strong bg-field px-1.5 text-ui text-text disabled:cursor-default disabled:opacity-50'

/** Four text rules; the two short ones sit flush to the aligned edge. */
function AlignIcon({ align }: { align: 'left' | 'center' | 'right' }): JSX.Element {
  const shortStart = { left: 2, center: 4.5, right: 7 }[align]

  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
      <path
        d={`M2 3h12M${shortStart} 6.5h7M2 10h12M${shortStart} 13.5h7`}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** A square and a circle overlapping — the shapes gallery as `currentColor` line art (item 4). */
function ShapeIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
      <rect x="2" y="2" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10.5" cy="10.5" r="3.75" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function ImageIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="5.5" cy="6.5" r="1.25" fill="currentColor" />
      <path
        d="M2.5 11.5l3.5-3 3 2.5 2.5-2 2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const GROUP = 'flex items-center gap-0.5'

export function FormatBar(): JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className={`flex min-w-0 flex-1 flex-wrap items-center ${dividerGap()} px-2 py-1.5`}
    >
      <div className={GROUP}>
        <ToolButton label="Bold">
          <span className="font-semibold">B</span>
        </ToolButton>
        <ToolButton label="Italic">
          <span className="font-serif italic">I</span>
        </ToolButton>
        <ToolButton label="Underline">
          <span className="underline">U</span>
        </ToolButton>
        <ToolButton label="Strikethrough">
          <span className="line-through">S</span>
        </ToolButton>
      </div>

      <div className="flex items-center gap-1">
        <select aria-label="Font" disabled className={`${SELECT_BASE} w-32`} defaultValue="Inter">
          <option>Inter</option>
          <option>Segoe UI</option>
          <option>Georgia</option>
        </select>
        <select aria-label="Font size" disabled className={`${SELECT_BASE} w-16`} defaultValue="24">
          <option>18</option>
          <option>24</option>
          <option>32</option>
          <option>44</option>
        </select>
      </div>

      <ToolButton label="Text color">
        <span className="flex flex-col items-center gap-0.5">
          <span className="text-ui-sm leading-none">A</span>
          {/* A colour bar, not text: the opaque accent carries no foreground on purpose. */}
          <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-accent" />
        </span>
      </ToolButton>

      <div className={GROUP}>
        <ToolButton label="Align left">
          <AlignIcon align="left" />
        </ToolButton>
        <ToolButton label="Align center">
          <AlignIcon align="center" />
        </ToolButton>
        <ToolButton label="Align right">
          <AlignIcon align="right" />
        </ToolButton>
      </div>

      <div className={GROUP}>
        <LabelledToolButton label="Insert shape">
          <ShapeIcon />
          Shape
        </LabelledToolButton>
        <LabelledToolButton label="Insert image">
          <ImageIcon />
          Image
        </LabelledToolButton>
      </div>
    </div>
  )
}
