/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBar } from '../../../src/renderer/src/features/statusbar/StatusBar'
import { evaluateBudget } from '../../../src/shared/agent/budget'

afterEach(cleanup)

const base = {
  currentSlide: 1,
  slideCount: 3,
  themeName: 'Ocean',
  issueCount: 0,
  sessionCostUsd: 0,
  budget: evaluateBudget(0, null),
  skills: null,
}

describe('StatusBar Present button', () => {
  it('enters Present when clicked and enabled', () => {
    const onPresent = vi.fn()
    render(<StatusBar {...base} onPresent={onPresent} />)

    const button = screen.getByRole('button', { name: /present/i })
    expect(button.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(button)
    expect(onPresent).toHaveBeenCalledTimes(1)
  })

  it('stays a disabled placeholder without a handler', () => {
    render(<StatusBar {...base} />)
    const button = screen.getByRole('button', { name: /present/i })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    // No handler means a click does nothing — nothing to assert but that it does not throw.
    fireEvent.click(button)
  })
})
