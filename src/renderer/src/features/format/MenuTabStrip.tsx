import type { JSX } from 'react'

/**
 * The ribbon tab strip. v1 ships a single "Home" tab (20-ui-wireframes.md);
 * additional tabs land with the features that need them.
 *
 * `documentName` is what the user has open. It defaults to the unsaved-document label rather than
 * being required, so the strip stays a pure presentational component and every existing mount keeps
 * working; File ▸ Open (M4.5) passes the real file name once a document is adopted.
 */
export type MenuTabStripProps = { documentName?: string }

export function MenuTabStrip({
  documentName = 'Untitled.sloodge',
}: MenuTabStripProps = {}): JSX.Element {
  return (
    <div className="flex shrink-0 items-end gap-1 border-b border-chrome-line bg-chrome px-2 pt-1 dark:border-ink-line dark:bg-ink">
      <button
        type="button"
        aria-current="true"
        className="-mb-px rounded-t border border-chrome-line border-b-white bg-white px-4 py-1.5 text-[13px] font-semibold text-accent dark:border-ink-line dark:border-b-ink-alt dark:bg-ink-alt dark:text-ink-fg"
      >
        Home
      </button>
      <span className="ml-auto self-center pr-1 text-[11px] tracking-wide text-chrome-muted dark:text-ink-muted">
        sloodge — {documentName}
      </span>
    </div>
  )
}
