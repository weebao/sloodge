/**
 * @vitest-environment happy-dom
 *
 * The Auth tab's honesty about where credentials go (M2.7 round 2).
 *
 * Round 1 rendered "credentials ... never leave this machine except as requests to Anthropic" at the
 * exact moment of credential entry — a sentence that is false whenever `ANTHROPIC_BASE_URL` points
 * somewhere else. These tests pin the replacement: a warning shown BEFORE the inputs, and copy that
 * no longer overpromises.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthTab } from '../../../src/renderer/src/features/settings/AuthTab'
import { deriveAuthStatus, UNCONFIGURED } from '../../../src/shared/agent/auth'
import { DEFAULT_ENDPOINT } from '../../../src/shared/agent/endpoint'

vi.mock('../../../src/renderer/src/features/chat/agentClient', () => ({
  getAgentBridge: () => undefined,
}))

afterEach(cleanup)

const noop = (): void => undefined

describe('AuthTab — endpoint disclosure', () => {
  it('shows no warning on the default endpoint', () => {
    render(
      <AuthTab
        status={deriveAuthStatus(UNCONFIGURED, UNCONFIGURED, DEFAULT_ENDPOINT)}
        onDirtyChange={noop}
      />,
    )
    expect(screen.queryByTestId('auth-endpoint-warning')).toBeNull()
  })

  /** Mutation check: drop the warning block from AuthTab and this fails. */
  it('warns, naming the host, when requests are routed elsewhere', () => {
    render(
      <AuthTab
        status={deriveAuthStatus(UNCONFIGURED, UNCONFIGURED, {
          custom: true,
          host: 'https://proxy.internal',
        })}
        onDirtyChange={noop}
      />,
    )
    const warning = screen.getByTestId('auth-endpoint-warning')
    expect(warning.textContent).toContain('https://proxy.internal')
    expect(warning.textContent).toMatch(/credentials/i)
  })

  it('places the warning before both credential inputs, not after', () => {
    render(
      <AuthTab
        status={deriveAuthStatus(UNCONFIGURED, UNCONFIGURED, {
          custom: true,
          host: 'https://proxy.internal',
        })}
        onDirtyChange={noop}
      />,
    )
    const warning = screen.getByTestId('auth-endpoint-warning')
    const token = screen.getByLabelText('Claude subscription token')
    const key = screen.getByLabelText('Anthropic API key')
    // A warning under the inputs is one the user reads after pasting, which is too late.
    expect(warning.compareDocumentPosition(token) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(warning.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('no longer promises credentials only ever reach Anthropic', () => {
    const { container } = render(
      <AuthTab
        status={deriveAuthStatus(UNCONFIGURED, UNCONFIGURED, DEFAULT_ENDPOINT)}
        onDirtyChange={noop}
      />,
    )
    const text = container.textContent ?? ''
    expect(text).not.toContain('never leave this machine')
    expect(text).toMatch(/configured Anthropic endpoint/i)
  })
})
