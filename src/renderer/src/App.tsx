import type { JSX } from 'react'

/**
 * The application shell. M0.3 renders an empty frame — the ribbon, thumbnail
 * rail, canvas and chat panes land in their own milestones.
 */
export function App(): JSX.Element {
  return <div id="sloodge-shell" className="flex h-screen w-screen flex-col overflow-hidden" />
}
