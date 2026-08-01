/**
 * @vitest-environment happy-dom
 *
 * The menu → renderer hop for export: `file.export.pdf` (M4.2) and `file.export.html` (M4.4) must
 * route to the renderer (`menuActionTarget`) and, once there, fire *their own* trigger
 * (`useMenuActions`). The pipelines are covered elsewhere; this pins the two ends of the delivery
 * that CI can otherwise not see, including the cross-fire check that a swapped pair would red.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { menuActionTarget } from '../../../src/main/menu/menuRouting'
import { useMenuActions, type SloodgeBridge } from '../../../src/renderer/src/app/useMenuActions'
import type { MenuAction } from '../../../src/shared/ipc-contract'

afterEach(() => {
  cleanup()
  delete window.sloodge
  vi.restoreAllMocks()
})

describe('menuActionTarget', () => {
  it('forwards file.export.pdf and file.export.pptx to the renderer (the deck lives there)', () => {
    expect(menuActionTarget('file.export.pdf')).toBe('renderer')
    expect(menuActionTarget('file.export.pptx')).toBe('renderer')
  })

  it('forwards file.export.html to the renderer (M4.4)', () => {
    expect(menuActionTarget('file.export.html')).toBe('renderer')
  })

  it('still logs the not-yet-wired File actions', () => {
    // `file.open` left this list at M4.5; `file.new` is the last unclaimed File id.
    expect(menuActionTarget('file.new')).toBe('log')
  })

  it('still forwards edit actions', () => {
    expect(menuActionTarget('edit.undo')).toBe('renderer')
  })
})

function fakeBridge(): SloodgeBridge & { emit: (action: MenuAction) => void } {
  const listeners = new Set<(action: MenuAction) => void>()
  return {
    onMenuAction(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(action) {
      for (const listener of listeners) listener(action)
    },
  }
}

function Harness({
  onExportPdf,
  onExportPptx = vi.fn(),
  onExportHtml = vi.fn(),
}: {
  onExportPdf: () => void
  onExportPptx?: () => void
  onExportHtml?: () => void
}): React.JSX.Element {
  useMenuActions({ undo: vi.fn(), redo: vi.fn() }, onExportPdf, onExportPptx, onExportHtml)
  return <div />
}

describe('useMenuActions — export', () => {
  it('fires the export trigger on file.export.pdf', () => {
    const bridge = fakeBridge()
    window.sloodge = bridge
    const onExportPdf = vi.fn()
    render(<Harness onExportPdf={onExportPdf} />)

    bridge.emit('file.export.pdf')
    expect(onExportPdf).toHaveBeenCalledTimes(1)
  })

  it('fires the pptx trigger on file.export.pptx and not on pdf', () => {
    const bridge = fakeBridge()
    window.sloodge = bridge
    const onExportPdf = vi.fn()
    const onExportPptx = vi.fn()
    render(<Harness onExportPdf={onExportPdf} onExportPptx={onExportPptx} />)

    bridge.emit('file.export.pptx')
    expect(onExportPptx).toHaveBeenCalledTimes(1)
    expect(onExportPdf).not.toHaveBeenCalled()
  })

  it('does not fire the export trigger on other actions', () => {
    const bridge = fakeBridge()
    window.sloodge = bridge
    const onExportPdf = vi.fn()
    render(<Harness onExportPdf={onExportPdf} />)

    bridge.emit('edit.undo')
    bridge.emit('file.new')
    expect(onExportPdf).not.toHaveBeenCalled()
  })

  it('fires the HTML trigger on file.export.html', () => {
    const bridge = fakeBridge()
    window.sloodge = bridge
    const onExportHtml = vi.fn()
    render(<Harness onExportPdf={vi.fn()} onExportHtml={onExportHtml} />)

    bridge.emit('file.export.html')
    expect(onExportHtml).toHaveBeenCalledTimes(1)
  })

  it('keeps the two export triggers apart', () => {
    // Swapping the two handler branches in `useMenuActions` would silently make File ▸ Export ▸ HTML
    // produce a PDF. Each id must fire exactly its own trigger and leave the other untouched.
    const bridge = fakeBridge()
    window.sloodge = bridge
    const onExportPdf = vi.fn()
    const onExportHtml = vi.fn()
    render(<Harness onExportPdf={onExportPdf} onExportHtml={onExportHtml} />)

    bridge.emit('file.export.pdf')
    expect(onExportPdf).toHaveBeenCalledTimes(1)
    expect(onExportHtml).not.toHaveBeenCalled()

    bridge.emit('file.export.html')
    expect(onExportHtml).toHaveBeenCalledTimes(1)
    expect(onExportPdf).toHaveBeenCalledTimes(1)
  })
})
