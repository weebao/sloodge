import type { JSX } from 'react'
import { FOCUS_RING } from '../../components/ui'

/**
 * The ribbon tab strip. v1 ships a single "Home" tab (20-ui-wireframes.md);
 * additional tabs land with the features that need them.
 *
 * `documentName` is what the user has open. It defaults to the unsaved-document label rather than
 * being required, so the strip stays a pure presentational component and every existing mount keeps
 * working; File ▸ Open (M4.5) passes the real file name once a document is adopted.
 *
 * Strip and toolbar row are two role surfaces with no line between them (ui-design-audit.md §4.1
 * item 3): the strip is `surface`, the row under it `surface-raised`, and the selected tab is drawn
 * in the row's colour with no bottom edge, so it reads as part of the panel it opens — the tone step
 * does the separating a `border-b` used to. With no strip border left to overlap, the `-mb-px` that
 * used to hide it is gone too. `text-accent` needs no `dark:` fallback since M8b.2 declared the
 * dark accent (4.66:1 on `surface-raised`, audit T5).
 */
export type MenuTabStripProps = { documentName?: string }

export function MenuTabStrip({
  documentName = 'Untitled.sloodge',
}: MenuTabStripProps = {}): JSX.Element {
  return (
    <div className="flex shrink-0 items-end gap-1 bg-surface px-2 pt-1">
      <button
        type="button"
        aria-current="true"
        className={`rounded-t-control border border-b-0 border-line bg-surface-raised px-4 py-1.5 text-ui font-semibold text-accent ${FOCUS_RING}`}
      >
        Home
      </button>
      <span className="ml-auto self-center pr-1 text-caption tracking-caps text-text-muted">
        sloodge — {documentName}
      </span>
    </div>
  )
}
