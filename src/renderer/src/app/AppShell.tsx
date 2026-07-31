import { useCallback, useState, type JSX } from 'react'
import { SlideCanvas } from '../features/canvas/SlideCanvas'
import { ChatPanel } from '../features/chat/ChatPanel'
import { ThumbnailRail } from '../features/deck/ThumbnailRail'
import { FormatBar } from '../features/format/FormatBar'
import { MenuTabStrip } from '../features/format/MenuTabStrip'
import { StatusBar } from '../features/statusbar/StatusBar'

/** Placeholder deck size until the document milestone provides a real one. */
const PLACEHOLDER_SLIDE_COUNT = 3

/**
 * The PowerPoint-like frame (20-ui-wireframes.md): tab strip + format bar on
 * top, thumbnail rail / canvas / chat in the middle, status bar at the bottom.
 * M0.4 is static chrome; the only live state is the selected thumbnail.
 */
export function AppShell(): JSX.Element {
  const [currentSlide, setCurrentSlide] = useState(1)

  const handleSelectSlide = useCallback((index: number) => {
    setCurrentSlide(index)
  }, [])

  return (
    <div
      id="sloodge-shell"
      className="flex h-screen w-screen flex-col overflow-hidden bg-shell-bg text-shell-fg dark:bg-ink dark:text-ink-fg"
    >
      <MenuTabStrip />
      <FormatBar />
      <div className="flex min-h-0 flex-1">
        <ThumbnailRail
          slideCount={PLACEHOLDER_SLIDE_COUNT}
          currentSlide={currentSlide}
          onSelectSlide={handleSelectSlide}
        />
        <SlideCanvas currentSlide={currentSlide} />
        <ChatPanel />
      </div>
      <StatusBar
        currentSlide={currentSlide}
        slideCount={PLACEHOLDER_SLIDE_COUNT}
        themeName="Ocean"
        issueCount={0}
        sessionCost="$0.00"
      />
    </div>
  )
}
