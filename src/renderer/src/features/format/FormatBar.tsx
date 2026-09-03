import type { JSX, ReactNode } from 'react'

/**
 * The formatting toolbar. Most buttons are still cosmetic (M0.4): they carry
 * `aria-disabled` so they still hover and focus, selects are plainly
 * `disabled` because a focusable-but-unusable select is a trap.
 *
 * **The Design Mode toggle deliberately does not live here** (M3.11). This row is a tab panel — M6.1
 * swaps its contents per ribbon tab, contextually — so a control placed here is reachable only on
 * some tabs. Design Mode is the switch that decides whether clicking the canvas selects or interacts,
 * and it has to be operable at all times, so it moved to `DesignModeToggle`, rendered as persistent
 * chrome by `AppShell`. See that file's header for the full argument.
 */

const BUTTON_BASE =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded border border-transparent px-2 text-[13px] text-shell-fg transition-colors hover:border-chrome-line hover:bg-chrome-alt active:bg-chrome-line dark:text-ink-fg dark:hover:border-ink-line dark:hover:bg-ink-alt'

function ToolButton({
  label,
  children,
  wide = false,
}: {
  label: string
  children: ReactNode
  wide?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      aria-disabled="true"
      aria-label={label}
      title={`${label} (not wired up yet)`}
      className={`${BUTTON_BASE} ${wide ? '' : 'w-7 px-0'}`}
    >
      {children}
    </button>
  )
}

function Divider(): JSX.Element {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-chrome-line dark:bg-ink-line" />
}

const SELECT_BASE =
  'h-7 rounded border border-chrome-line bg-white px-1.5 text-[13px] text-shell-fg dark:border-ink-line dark:bg-ink-alt dark:text-ink-fg'

/** Four text rules; the two short ones sit flush to the aligned edge. */
function AlignIcon({ align }: { align: 'left' | 'center' | 'right' }): JSX.Element {
  const shortStart = { left: 2, center: 4.5, right: 7 }[align]

  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <path
        d={`M2 3h12M${shortStart} 6.5h7M2 10h12M${shortStart} 13.5h7`}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function FormatBar(): JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 px-2 py-1.5"
    >
      <ToolButton label="Bold">
        <span className="font-bold">B</span>
      </ToolButton>
      <ToolButton label="Italic">
        <span className="italic font-serif">I</span>
      </ToolButton>
      <ToolButton label="Underline">
        <span className="underline">U</span>
      </ToolButton>
      <ToolButton label="Strikethrough">
        <span className="line-through">S</span>
      </ToolButton>

      <Divider />

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

      <Divider />

      <ToolButton label="Text color">
        <span className="flex flex-col items-center leading-none">
          <span className="text-[12px]">A</span>
          <span aria-hidden="true" className="mt-0.5 h-[3px] w-4 rounded-sm bg-accent" />
        </span>
      </ToolButton>

      <Divider />

      <ToolButton label="Align left">
        <AlignIcon align="left" />
      </ToolButton>
      <ToolButton label="Align center">
        <AlignIcon align="center" />
      </ToolButton>
      <ToolButton label="Align right">
        <AlignIcon align="right" />
      </ToolButton>

      <Divider />

      <ToolButton label="Insert shape" wide>
        <span aria-hidden="true">⬚</span> Shape
      </ToolButton>
      <ToolButton label="Insert image" wide>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
          <circle cx="5.5" cy="6.5" r="1.2" fill="currentColor" />
          <path d="M2 11.5l3.5-3 3 2.5 2.5-2 3 3" stroke="currentColor" strokeLinejoin="round" />
        </svg>{' '}
        Image
      </ToolButton>
    </div>
  )
}
