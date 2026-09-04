/**
 * @vitest-environment happy-dom
 *
 * The status bar's M2.5 segments: the cost meter with its budget state, and §8's `skills: fallback`
 * indicator. The Present button is covered in `present/status-bar-present.test.tsx`.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusBar } from '../../../src/renderer/src/features/statusbar/StatusBar'
import { evaluateBudget } from '../../../src/shared/agent/budget'
import type { SessionSkills } from '../../../src/renderer/src/stores/sessionMeterStore'

afterEach(cleanup)

function renderBar(
  options: {
    costUsd?: number
    capUsd?: number | null
    skills?: SessionSkills
    budgetUnknown?: boolean
  } = {},
): void {
  const costUsd = options.costUsd ?? 0
  render(
    <StatusBar
      currentSlide={1}
      slideCount={3}
      themeName="Ocean"
      issueCount={0}
      sessionCostUsd={costUsd}
      budget={evaluateBudget(costUsd, options.capUsd ?? null)}
      budgetUnknown={options.budgetUnknown ?? false}
      skills={options.skills ?? null}
    />,
  )
}

const cost = (): HTMLElement => screen.getByTestId('statusbar-cost')

describe('StatusBar — cost meter', () => {
  it('shows the session estimate, marked approximate', () => {
    renderBar({ costUsd: 0.42 })
    // §10: the "≈" is a claim about provenance — a client-side estimate, never billing truth — so it
    // travels with the number everywhere it is shown.
    expect(cost().textContent).toContain('≈')
    expect(cost().textContent).toContain('$0.42')
    expect(cost().textContent).toContain('session')
  })

  it('shows the cap alongside the spend when one is configured', () => {
    renderBar({ costUsd: 0.34, capUsd: 2 })
    expect(cost().textContent).toContain('$0.34 / $2.00')
    expect(screen.getByTestId('statusbar-budget-bar')).toBeTruthy()
  })

  it('says the limit is unknown when the cap could not be read, rather than showing none', () => {
    // A failed probe leaves the store unloaded, so `budget` evaluates uncapped — but main is still
    // enforcing the real cap. A bare spend here would read as "no limit" to the user.
    renderBar({ costUsd: 0.42, budgetUnknown: true })
    expect(cost().textContent).toContain('limit unknown')
    expect(cost().title).toMatch(/could not be read/i)
  })

  it('omits the cap and the bar when the session is uncapped', () => {
    renderBar({ costUsd: 0.34, capUsd: null })
    expect(cost().textContent).not.toContain('/')
    expect(screen.queryByTestId('statusbar-budget-bar')).toBeNull()
  })

  it('reads "$0.00" for an untouched session and "< $0.01" for real sub-cent spend', () => {
    renderBar({ costUsd: 0 })
    expect(cost().textContent).toContain('$0.00')
    cleanup()
    renderBar({ costUsd: 0.002 })
    expect(cost().textContent).toContain('< $0.01')
  })

  it('turns amber at the warn threshold and red once turns are refused', () => {
    renderBar({ costUsd: 0.5, capUsd: 2 })
    expect(cost().className).not.toMatch(/amber|red/)
    cleanup()

    renderBar({ costUsd: 1.7, capUsd: 2 })
    expect(cost().className).toMatch(/amber/)
    cleanup()

    // Red *before* the user is told no, so the composer refusing is never a surprise.
    renderBar({ costUsd: 2, capUsd: 2 })
    expect(cost().className).toMatch(/red/)
  })

  it('never overflows the progress bar on an overshoot', () => {
    renderBar({ costUsd: 9, capUsd: 2 })
    const fill = screen.getByTestId('statusbar-budget-bar').firstElementChild as HTMLElement
    expect(fill.style.width).toBe('100%')
  })
})

describe('StatusBar — §8 skills indicator', () => {
  it('says nothing for a healthy session', () => {
    // A permanent "skills: ok" is four words of chrome that are true nearly always, which is exactly
    // how a status indicator stops being read.
    renderBar({ skills: 'ok' })
    expect(screen.queryByTestId('statusbar-skills')).toBeNull()
  })

  it('says nothing before a session has started', () => {
    renderBar({ skills: null })
    expect(screen.queryByTestId('statusbar-skills')).toBeNull()
  })

  it('reads "skills: fallback" once the session has restarted into the inlined prompt', () => {
    // The acceptance criterion from the M2.5 roadmap row: a session whose init reported missing
    // skills restarts once, and the indicator reads this.
    renderBar({ skills: 'fallback' })
    expect(screen.getByTestId('statusbar-skills').textContent).toBe('skills: fallback')
  })

  it('reads "skills: unavailable" when the fallback could not be built either', () => {
    renderBar({ skills: 'unavailable' })
    const el = screen.getByTestId('statusbar-skills')
    expect(el.textContent).toBe('skills: unavailable')
    // The unrecoverable state is the louder of the two.
    expect(el.className).toMatch(/red/)
  })

  it('explains itself on hover rather than leaving a bare word in the chrome', () => {
    renderBar({ skills: 'fallback' })
    expect(screen.getByTestId('statusbar-skills').getAttribute('title')).toMatch(/token cost/i)
  })
})
