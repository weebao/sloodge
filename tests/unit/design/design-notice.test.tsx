/**
 * @vitest-environment happy-dom
 *
 * `DesignNotice` is the host a refused text edit is explained from (M3.11 round-8). It sits on the
 * canvas rather than inside `SelectionOverlay` because the two exits that most need it — turning
 * Design Mode off, and Present, which forces it off — refuse the edit while the overlay is being
 * unmounted. So the two things worth pinning down here are that it does not need Design Mode to be
 * on, and that a notice never outlives the slide it names.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DesignNotice } from '../../../src/renderer/src/features/design/DesignNotice'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'

beforeEach(() => {
  useDesignStore.setState({ enabled: true, notice: null })
})

afterEach(cleanup)

describe('DesignNotice', () => {
  it('shows a refusal raised on the slide it is mounted for', () => {
    useDesignStore.setState({ notice: { slideId: 'slide-1', text: 'That text is too long' } })
    render(<DesignNotice slideId="slide-1" />)

    const notice = screen.getByTestId('design-notice')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('That text is too long')
  })

  it('shows it with Design Mode off — the state the toggle refusal lands in', () => {
    useDesignStore.setState({
      enabled: false,
      notice: { slideId: 'slide-1', text: 'That text is too long' },
    })
    render(<DesignNotice slideId="slide-1" />)

    expect(screen.getByTestId('design-notice').textContent).toContain('That text is too long')
  })

  it('drops a notice raised on another slide rather than showing it here', () => {
    useDesignStore.setState({ notice: { slideId: 'slide-1', text: 'That text is too long' } })
    render(<DesignNotice slideId="slide-2" />)

    expect(screen.queryByTestId('design-notice')).toBeNull()
    // Dropped, not merely hidden: a there-and-back must not bring it up again (round-4).
    expect(useDesignStore.getState().notice).toBeNull()
  })

  it('dismisses on the ✕', () => {
    useDesignStore.setState({ notice: { slideId: 'slide-1', text: 'That text is too long' } })
    render(<DesignNotice slideId="slide-1" />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(screen.queryByTestId('design-notice')).toBeNull()
    expect(useDesignStore.getState().notice).toBeNull()
  })
})
