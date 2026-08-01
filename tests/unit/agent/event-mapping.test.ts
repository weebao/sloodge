import { describe, expect, it } from 'vitest'
import {
  classifyAssistantError,
  classifyException,
  classifyResultSubtype,
  isRecoverable,
  mapSdkMessage,
  toolChipLabel,
} from '../../../src/main/agent/event-mapping'
import type { AgentEvent } from '../../../src/shared/agent/types'

describe('classifyAssistantError', () => {
  it.each([
    ['authentication_failed', 'auth'],
    ['oauth_org_not_allowed', 'auth'],
    ['billing_error', 'auth'],
    ['rate_limit', 'rate-limit'],
    ['overloaded', 'overloaded'],
    ['max_output_tokens', 'max-turns'],
    ['server_error', 'unknown'],
    ['something_new', 'unknown'],
  ])('maps %s -> %s', (input, expected) => {
    expect(classifyAssistantError(input)).toBe(expected)
  })
})

describe('classifyResultSubtype', () => {
  it('maps error subtypes and returns null for success', () => {
    expect(classifyResultSubtype('error_max_budget_usd')).toBe('budget')
    expect(classifyResultSubtype('error_max_turns')).toBe('max-turns')
    expect(classifyResultSubtype('error_during_execution')).toBe('unknown')
    expect(classifyResultSubtype('success')).toBeNull()
  })

  it('treats an UNRECOGNISED error_* subtype as an error, not as success', () => {
    // The old `default: null` rendered an unfamiliar failure as a clean successful turn. M2.5 makes
    // that costlier: a future `error_max_budget_*` variant would bill the user and show success.
    expect(classifyResultSubtype('error_max_budget_tokens')).toBe('unknown')
    expect(classifyResultSubtype('error_something_new')).toBe('unknown')
    // Non-error subtypes still produce no error event.
    expect(classifyResultSubtype('partial')).toBeNull()
  })
})

describe('classifyException', () => {
  it('classifies transport and runtime failures by name/message', () => {
    expect(classifyException(new Error('getaddrinfo ENOTFOUND api.anthropic.com')).kind).toBe(
      'network',
    )
    expect(classifyException(new Error('401 Unauthorized: invalid api key')).kind).toBe('auth')
    expect(classifyException(new Error('claude executable not found')).kind).toBe('runtime-missing')
    expect(classifyException(new Error('429 rate-limit exceeded')).kind).toBe('rate-limit')
    expect(classifyException(new Error('kaboom')).kind).toBe('unknown')
  })

  it('preserves a usable message and tolerates non-Error throws', () => {
    expect(classifyException('offline').message).toBe('offline')
    expect(classifyException(null).message).toBe('The agent turn failed.')
  })
})

describe('isRecoverable', () => {
  it('marks auth and runtime-missing as dead ends, others as retryable', () => {
    expect(isRecoverable('auth')).toBe(false)
    expect(isRecoverable('runtime-missing')).toBe(false)
    expect(isRecoverable('network')).toBe(true)
    expect(isRecoverable('rate-limit')).toBe(true)
  })
})

describe('toolChipLabel', () => {
  it('strips the mcp prefix and underscores', () => {
    expect(toolChipLabel('mcp__slides__update_slide')).toBe('update slide')
    expect(toolChipLabel('Read')).toBe('Read')
  })
})

const seen = (): Set<string> => new Set<string>()

describe('mapSdkMessage', () => {
  it('maps init to a ready event', () => {
    const events = mapSdkMessage(
      { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5', tools: [] },
      seen(),
    )
    expect(events).toEqual([
      { type: 'ready', sessionId: 'sess-1', model: 'claude-opus-5', skills: [] },
    ])
  })

  it('carries the loaded skill list off init, so §8 can assert the bundled skills arrived', () => {
    const events = mapSdkMessage(
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        model: 'claude-opus-5',
        skills: ['slide-deck', 'svg-animation', 'interactive-graph'],
      },
      seen(),
    )
    expect(events).toEqual([
      {
        type: 'ready',
        sessionId: 'sess-1',
        model: 'claude-opus-5',
        skills: ['slide-deck', 'svg-animation', 'interactive-graph'],
      },
    ])
  })

  it('degrades a malformed skills field to an empty list rather than dropping the ready event', () => {
    const from = (skills: unknown): unknown =>
      mapSdkMessage(
        { type: 'system', subtype: 'init', session_id: 's', model: 'm', skills },
        seen(),
      )[0]
    expect(from('slide-deck')).toMatchObject({ type: 'ready', skills: [] })
    expect(from([1, 'slide-deck', null])).toMatchObject({ skills: ['slide-deck'] })
  })

  it('ignores a system message that is not init', () => {
    expect(mapSdkMessage({ type: 'system', subtype: 'other' }, seen())).toEqual([])
  })

  it('extracts a text delta from a stream_event', () => {
    const events = mapSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      },
      seen(),
    )
    expect(events).toEqual([{ type: 'assistant-delta', text: 'Hel' }])
  })

  it('ignores non-text deltas', () => {
    const events = mapSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } },
      },
      seen(),
    )
    expect(events).toEqual([])
  })

  it('reads assistant text from message.message.content and its usage', () => {
    const events = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'text', text: 'Done. ' },
            { type: 'text', text: 'Slide 3 updated.' },
          ],
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
        },
      },
      seen(),
    )
    expect(events).toEqual([
      {
        type: 'assistant-message',
        text: 'Done. Slide 3 updated.',
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
      },
    ])
  })

  it('emits tool-use chips from tool_use blocks', () => {
    const events = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          id: 'm2',
          content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__slides__create_slide', input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      seen(),
    )
    expect(events).toEqual([{ type: 'tool-use', toolUseId: 'tu1', label: 'create slide' }])
  })

  it('deduplicates assistant messages by id (parallel tool calls share one id)', () => {
    const set = seen()
    const msg = {
      type: 'assistant',
      message: {
        id: 'dup',
        content: [{ type: 'text', text: 'once' }],
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0 },
      },
    }
    expect(mapSdkMessage(msg, set)).toHaveLength(1)
    expect(mapSdkMessage(msg, set)).toEqual([])
  })

  it('surfaces an assistant error enum as an error event, not deduplicated', () => {
    const events = mapSdkMessage(
      { type: 'assistant', error: 'rate_limit', message: { id: 'e1' } },
      seen(),
    )
    expect(events).toEqual([
      { type: 'error', kind: 'rate-limit', message: 'rate_limit', recoverable: true },
    ])
  })

  it('emits turn-end for a successful result with no trailing error', () => {
    const events = mapSdkMessage(
      { type: 'result', subtype: 'success', total_cost_usd: 0.041, session_id: 's' },
      seen(),
    )
    expect(events).toEqual([{ type: 'turn-end', costUsd: 0.041, subtype: 'success' }])
  })

  it('emits turn-end AND an error for a budget-exhausted result (error carries cost too)', () => {
    const events = mapSdkMessage(
      { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 2 },
      seen(),
    )
    const kinds = events.map((e: AgentEvent) => e.type)
    expect(kinds).toEqual(['turn-end', 'error'])
    expect(events[0]).toEqual({ type: 'turn-end', costUsd: 2, subtype: 'error_max_budget_usd' })
    expect(events[1]).toMatchObject({ type: 'error', kind: 'budget', recoverable: true })
    // Empty message on purpose: the renderer's copy table owns the wording for every kind it has a
    // calibrated sentence for, and `errorCopy` prefers a non-empty message — so a diagnostic string
    // here would put "Turn ended: error_max_budget_usd" on screen instead (M2.5).
    expect(events[1]).toMatchObject({ message: '' })
  })

  it('deduplicates a repeated result by its uuid — a cost invariant, not a display one', () => {
    // The accumulator downstream counts open turns, so it cannot tell a repeated `result` from a
    // second turn's. Only this layer has the identity that can, so dedup belongs here.
    const shared = seen()
    const first = mapSdkMessage(
      { type: 'result', uuid: 'r-1', subtype: 'success', total_cost_usd: 0.1 },
      shared,
    )
    const repeat = mapSdkMessage(
      { type: 'result', uuid: 'r-1', subtype: 'success', total_cost_usd: 0.1 },
      shared,
    )
    const other = mapSdkMessage(
      { type: 'result', uuid: 'r-2', subtype: 'success', total_cost_usd: 0.9 },
      shared,
    )
    expect(first).toEqual([{ type: 'turn-end', costUsd: 0.1, subtype: 'success' }])
    expect(repeat).toEqual([])
    expect(other).toEqual([{ type: 'turn-end', costUsd: 0.9, subtype: 'success' }])
  })

  it('still maps a result that carries no uuid, rather than dropping the turn', () => {
    // An older or partial runtime must not lose its turn-end just because it omits the field.
    const shared = seen()
    expect(
      mapSdkMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.2 }, shared),
    ).toEqual([{ type: 'turn-end', costUsd: 0.2, subtype: 'success' }])
  })

  it('keeps the raw subtype only for `unknown`, where it is the best detail available', () => {
    const events = mapSdkMessage(
      { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 },
      seen(),
    )
    expect(events[1]).toMatchObject({
      kind: 'unknown',
      message: 'Turn ended: error_during_execution',
    })
  })

  it('defaults a missing cost to 0 rather than NaN', () => {
    const events = mapSdkMessage({ type: 'result', subtype: 'success' }, seen())
    expect(events).toEqual([{ type: 'turn-end', costUsd: 0, subtype: 'success' }])
  })

  it('ignores unknown and malformed messages', () => {
    expect(mapSdkMessage({ type: 'status' }, seen())).toEqual([])
    expect(mapSdkMessage(null, seen())).toEqual([])
    expect(mapSdkMessage('nope', seen())).toEqual([])
  })
})
