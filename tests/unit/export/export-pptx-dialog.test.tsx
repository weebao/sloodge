/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportPptxDialog } from '../../../src/renderer/src/features/export/ExportPptxDialog'

afterEach(cleanup)

describe('ExportPptxDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ExportPptxDialog open={false} slideCount={3} onCancel={vi.fn()} onExport={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('offers the three fidelity options with Auto default and exports the chosen one', () => {
    const onExport = vi.fn()
    render(<ExportPptxDialog open slideCount={4} onCancel={vi.fn()} onExport={onExport} />)

    expect(screen.getByRole('dialog')).toBeTruthy()
    const auto = screen.getByRole('radio', { name: /Auto/ }) as HTMLInputElement
    expect(auto.checked).toBe(true)

    // Default export uses Auto.
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(onExport).toHaveBeenCalledWith('auto')

    // Switching to Picture-perfect exports raster.
    fireEvent.click(screen.getByRole('radio', { name: /Picture-perfect/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    expect(onExport).toHaveBeenLastCalledWith('raster')
  })

  it('cancels via the Cancel button', () => {
    const onCancel = vi.fn()
    render(<ExportPptxDialog open slideCount={1} onCancel={onCancel} onExport={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
