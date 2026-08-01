/**
 * @vitest-environment happy-dom
 *
 * The menu → renderer hop for PDF export (M4.2): `file.export.pdf` must route to the renderer
 * (`menuActionTarget`) and, once there, fire the export trigger (`useMenuActions`). The pipeline is
 * covered elsewhere; this pins the two ends of the delivery that CI can otherwise not see.
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

  it('still logs the not-yet-wired File exports', () => {
    expect(menuActionTarget('file.export.html')).toBe('log')
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
  onExportPptx,
}: {
  onExportPdf: () => void
  onExportPptx?: () => void
}): React.JSX.Element {
  useMenuActions({ undo: vi.fn(), redo: vi.fn() }, onExportPdf, onExportPptx)
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
})
