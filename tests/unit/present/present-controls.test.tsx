/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresentControls } from '../../../src/renderer/src/features/present/PresentControls'

afterEach(cleanup)

function setup(overrides: Partial<Parameters<typeof PresentControls>[0]> = {}) {
  const handlers = { onPrev: vi.fn(), onNext: vi.fn(), onExit: vi.fn() }
  render(<PresentControls index={1} slideCount={8} visible {...handlers} {...overrides} />)
  return handlers
}

describe('PresentControls', () => {
  it('shows the 1-based position over the total', () => {
    setup({ index: 1, slideCount: 8 })
    expect(screen.getByText('2 / 8')).toBeTruthy()
  })

  it('wires prev / next / exit to their handlers', () => {
    const handlers = setup({ index: 3 })
    fireEvent.click(screen.getByLabelText('Previous slide'))
    fireEvent.click(screen.getByLabelText('Next slide'))
    fireEvent.click(screen.getByLabelText('Exit presentation (Esc)'))
    expect(handlers.onPrev).toHaveBeenCalledTimes(1)
    expect(handlers.onNext).toHaveBeenCalledTimes(1)
    expect(handlers.onExit).toHaveBeenCalledTimes(1)
  })

  it('disables Previous on the first slide and Next on the last', () => {
    setup({ index: 0, slideCount: 3 })
    expect((screen.getByLabelText('Previous slide') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Next slide') as HTMLButtonElement).disabled).toBe(false)
    cleanup()
    setup({ index: 2, slideCount: 3 })
    expect((screen.getByLabelText('Next slide') as HTMLButtonElement).disabled).toBe(true)
  })

  it('marks the cluster hidden from assistive tech when not visible', () => {
    setup({ visible: false })
    expect(screen.getByLabelText('Presentation controls').getAttribute('aria-hidden')).toBe('true')
  })
})
