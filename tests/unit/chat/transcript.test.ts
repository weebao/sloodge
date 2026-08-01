import { describe, expect, it } from 'vitest'
import type { AgentErrorKind, AgentEvent, AgentUsage } from '../../../src/shared/agent/types'
import {
  errorCopy,
  initialTranscript,
  reduceTranscript,
  toolChipStyle,
  type ChatMessage,
  type Transcript,
  type TranscriptAction,
} from '../../../src/renderer/src/features/chat/transcript'

/* -------------------------------------------------------------------------------------------- *
 * Scripted-event helpers — feed a sequence, assert the transcript (the M2.3 testability contract)
 * -------------------------------------------------------------------------------------------- */

const usage = (i: number, o: number, c: number): AgentUsage => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: c,
})

const ev = (event: AgentEvent): TranscriptAction => ({ type: 'agent-event', event })
const sendTurn = (text: string): TranscriptAction => ({ type: 'user-send', text })

function run(actions: TranscriptAction[], start: Transcript = initialTranscript): Transcript {
  return actions.reduce(reduceTranscript, start)
}

function assistant(state: Transcript): Extract<ChatMessage, { kind: 'assistant' }> {
  const message = state.messages.find((m) => m.kind === 'assistant')
  if (message === undefined || message.kind !== 'assistant') throw new Error('no assistant message')
  return message
}

function lastAssistant(state: Transcript): Extract<ChatMessage, { kind: 'assistant' }> {
  const message = state.messages.toReversed().find((m) => m.kind === 'assistant')
  if (message === undefined || message.kind !== 'assistant') throw new Error('no assistant message')
  return message
}

/* -------------------------------------------------------------------------------------------- */

describe('reduceTranscript — user-send', () => {
  it('opens a turn: user bubble + streaming assistant bubble, turnState streaming', () => {
    const state = run([sendTurn('make a title slide')])
    expect(state.turnState).toBe('streaming')
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]).toEqual({ kind: 'user', id: 'u0', text: 'make a title slide' })
    expect(assistant(state)).toMatchObject({ text: '', tools: [], streaming: true, usage: null })
  })

  it('mints unique ids across turns from the in-state counter', () => {
    const state = run([sendTurn('one'), ev({ type: 'turn-end', costUsd: 0, subtype: 'success' })])
    const next = run([sendTurn('two')], state)
    const ids = next.messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('reduceTranscript — assistant text', () => {
  it('accumulates deltas into the live bubble', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'assistant-delta', text: 'Build' }),
      ev({ type: 'assistant-delta', text: 'ing…' }),
    ])
    expect(assistant(state).text).toBe('Building…')
  })

  it('fills text from a finalized message only when no deltas streamed, and folds usage', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'assistant-message', text: 'Done.', usage: usage(10, 5, 2) }),
    ])
    expect(assistant(state).text).toBe('Done.')
    expect(assistant(state).usage).toEqual(usage(10, 5, 2))
  })

  it('keeps streamed delta text over a finalized message, but still folds usage', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'assistant-delta', text: 'streamed text' }),
      ev({ type: 'assistant-message', text: 'streamed text', usage: usage(3, 4, 1) }),
    ])
    expect(assistant(state).text).toBe('streamed text')
    expect(assistant(state).usage).toEqual(usage(3, 4, 1))
  })

  it('sums usage across multiple assistant messages in one turn', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'assistant-message', text: 'a', usage: usage(1, 1, 1) }),
      ev({ type: 'assistant-message', text: 'b', usage: usage(2, 3, 4) }),
    ])
    expect(assistant(state).usage).toEqual(usage(3, 4, 5))
  })
})

describe('reduceTranscript — tool chips', () => {
  it('appends inline chips to the live bubble with mapped glyph + verb', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'tool-use', toolUseId: 't1', label: 'create slide' }),
      ev({ type: 'tool-use', toolUseId: 't2', label: 'update slide' }),
    ])
    expect(assistant(state).tools).toEqual([
      { toolUseId: 't1', glyph: '+', text: 'New slide' },
      { toolUseId: 't2', glyph: '✎', text: 'Editing slide' },
    ])
  })

  it('attaches a chip even before any assistant text arrives', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'tool-use', toolUseId: 't1', label: 'read slide' }),
    ])
    expect(assistant(state).tools).toHaveLength(1)
    expect(assistant(state).text).toBe('')
  })
})

describe('reduceTranscript — turn-end', () => {
  it('settles the bubble, returns to idle, and folds cost', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'assistant-delta', text: 'ok' }),
      ev({ type: 'turn-end', costUsd: 0.0123, subtype: 'success' }),
    ])
    expect(state.turnState).toBe('idle')
    expect(assistant(state).streaming).toBe(false)
    expect(state.costUsd).toBeCloseTo(0.0123)
  })

  it('accumulates cost across turns', () => {
    let state = run([sendTurn('a'), ev({ type: 'turn-end', costUsd: 0.1, subtype: 'success' })])
    state = run([sendTurn('b'), ev({ type: 'turn-end', costUsd: 0.25, subtype: 'success' })], state)
    expect(state.costUsd).toBeCloseTo(0.35)
  })

  it('a second turn-end for a settled turn is a no-op and never re-folds cost', () => {
    const once = run([sendTurn('hi'), ev({ type: 'turn-end', costUsd: 0.05, subtype: 'success' })])
    const twice = reduceTranscript(
      once,
      ev({ type: 'turn-end', costUsd: 0.05, subtype: 'success' }),
    )
    expect(twice).toBe(once)
    expect(twice.costUsd).toBeCloseTo(0.05)
  })
})

describe('reduceTranscript — cost folds exactly once per turn (order-independent)', () => {
  it('streaming -> turn-end -> idle folds the cost once', () => {
    const state = run([sendTurn('hi'), ev({ type: 'turn-end', costUsd: 0.05, subtype: 'success' })])
    expect(state.turnState).toBe('idle')
    expect(state.costUsd).toBeCloseTo(0.05)
  })

  it('streaming -> error -> turn-end folds the failed turn cost once, keeping error', () => {
    // The result carrying cost can arrive *after* the error (the ordering the guard must survive).
    const state = run([
      sendTurn('hi'),
      ev({ type: 'error', kind: 'network', message: 'ECONNREFUSED', recoverable: true }),
      ev({ type: 'turn-end', costUsd: 0.03, subtype: 'error_during_execution' }),
    ])
    expect(state.turnState).toBe('error')
    expect(state.costUsd).toBeCloseTo(0.03)
  })

  it('streaming -> interrupt -> turn-end folds the interrupted turn cost once', () => {
    // interrupt-requested settles to `interrupted` BEFORE the SDK's post-interrupt result arrives;
    // that result's cost must still be counted (matching main's accumulator).
    const state = run([
      sendTurn('hi'),
      { type: 'interrupt-requested' },
      ev({ type: 'turn-end', costUsd: 0.04, subtype: 'success' }),
    ])
    expect(state.turnState).toBe('interrupted')
    expect(state.costUsd).toBeCloseTo(0.04)
  })

  it('an interrupted turn does not double-fold on a duplicate post-interrupt result', () => {
    const state = run([
      sendTurn('hi'),
      { type: 'interrupt-requested' },
      ev({ type: 'turn-end', costUsd: 0.04, subtype: 'success' }),
      ev({ type: 'turn-end', costUsd: 0.04, subtype: 'success' }),
    ])
    expect(state.costUsd).toBeCloseTo(0.04)
  })
})

describe('reduceTranscript — errors', () => {
  it('appends an error bubble and enters the error state', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'error', kind: 'network', message: 'ECONNREFUSED', recoverable: true }),
    ])
    expect(state.turnState).toBe('error')
    const error = state.messages.at(-1)
    expect(error).toMatchObject({
      kind: 'error',
      errorKind: 'network',
      recoverable: true,
      text: "Can't reach Claude. Slides and Design Mode still work offline.",
    })
    expect(assistant(state).streaming).toBe(false)
  })

  it('an interrupted error enters the interrupted state, not error', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'error', kind: 'interrupted', message: 'stopped', recoverable: true }),
    ])
    expect(state.turnState).toBe('interrupted')
  })

  it('a failed turn (turn-end then error) reads error, and still folds the error result cost', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'turn-end', costUsd: 0.02, subtype: 'error_max_turns' }),
      ev({ type: 'error', kind: 'max-turns', message: 'Turn ended', recoverable: true }),
    ])
    expect(state.turnState).toBe('error')
    expect(state.costUsd).toBeCloseTo(0.02)
  })
})

describe('reduceTranscript — interrupt', () => {
  it('interrupt-requested while streaming settles the bubble and enters interrupted', () => {
    const state = run([
      sendTurn('hi'),
      ev({ type: 'assistant-delta', text: 'partial' }),
      { type: 'interrupt-requested' },
    ])
    expect(state.turnState).toBe('interrupted')
    expect(assistant(state).streaming).toBe(false)
    expect(assistant(state).text).toBe('partial')
  })

  it('interrupt-requested while idle is a no-op', () => {
    const before = run([sendTurn('hi'), ev({ type: 'turn-end', costUsd: 0, subtype: 'success' })])
    const after = reduceTranscript(before, { type: 'interrupt-requested' })
    expect(after).toBe(before)
  })
})

describe('reduceTranscript — out-of-turn events are inert', () => {
  it('a delta with no open turn changes nothing', () => {
    const after = reduceTranscript(initialTranscript, ev({ type: 'assistant-delta', text: 'x' }))
    expect(after).toBe(initialTranscript)
  })

  it('a delta after the bubble settled does not reopen it', () => {
    const settled = run([sendTurn('hi'), ev({ type: 'turn-end', costUsd: 0, subtype: 'success' })])
    const after = reduceTranscript(settled, ev({ type: 'assistant-delta', text: 'late' }))
    expect(assistant(after).text).toBe('')
  })

  it('ready is a no-op on the transcript', () => {
    const state = run([sendTurn('hi')])
    const after = reduceTranscript(
      state,
      ev({ type: 'ready', sessionId: 's', model: 'm', skills: [] }),
    )
    expect(after.messages).toEqual(state.messages)
  })
})

describe('reduceTranscript — a second turn targets its own bubble', () => {
  it('deltas after a new send accumulate into the new bubble, not the prior one', () => {
    let state = run([
      sendTurn('first'),
      ev({ type: 'assistant-delta', text: 'one' }),
      ev({ type: 'turn-end', costUsd: 0, subtype: 'success' }),
    ])
    state = run([sendTurn('second'), ev({ type: 'assistant-delta', text: 'two' })], state)

    const assistants = state.messages.filter((m) => m.kind === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(lastAssistant(state).text).toBe('two')
    // The first bubble is untouched.
    const first = assistants[0]
    expect(first?.kind === 'assistant' ? first.text : '').toBe('one')
  })

  it('a new send clears the error end-state back to streaming', () => {
    const errored = run([
      sendTurn('hi'),
      ev({ type: 'error', kind: 'auth', message: '401', recoverable: false }),
    ])
    const next = reduceTranscript(errored, sendTurn('retry'))
    expect(next.turnState).toBe('streaming')
  })
})

/* -------------------------------------------------------------------------------------------- *
 * Pure mappers
 * -------------------------------------------------------------------------------------------- */

describe('toolChipStyle', () => {
  it.each([
    ['create slide', '+', 'New slide'],
    ['update slide', '✎', 'Editing slide'],
    ['read slide', '👁', 'Reading slide'],
    ['reorder', '⇅', 'Reordering slides'],
    ['screenshot slide', '📸', 'Rendering preview'],
  ])('maps %s to a glyph + verb', (label, glyph, text) => {
    expect(toolChipStyle(label)).toEqual({ glyph, text })
  })

  it('falls back to a gear glyph and the raw label for an unknown tool', () => {
    expect(toolChipStyle('frobnicate')).toEqual({ glyph: '⚙', text: 'frobnicate' })
  })
})

describe('errorCopy', () => {
  const kinds: AgentErrorKind[] = [
    'auth',
    'rate-limit',
    'overloaded',
    'network',
    'budget',
    'max-turns',
    'interrupted',
    'runtime-missing',
    'unknown',
  ]

  it('returns non-empty copy for every kind', () => {
    for (const kind of kinds) expect(errorCopy(kind, '').length).toBeGreaterThan(0)
  })

  it('surfaces the raw message for an unknown kind, and a generic line when it is empty', () => {
    expect(errorCopy('unknown', 'weird SDK failure')).toBe('weird SDK failure')
    expect(errorCopy('unknown', '   ')).toBe('The agent turn failed.')
  })
})
