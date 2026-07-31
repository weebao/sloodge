/**
 * The chat-box -> `query()` input side (50-agent-integration.md §2). Streaming-input mode wants an
 * `AsyncIterable<SDKUserMessage>` that stays open across turns; this is a queue with a wake-up.
 *
 * **The generator must never throw.** If the SDK's input generator throws, the SDK surfaces the
 * misleading error "Claude Code process aborted by user" — indistinguishable from a real Stop press.
 * So `send()` does nothing that can throw (it only pushes a pre-built object), and `stream()` only
 * ever yields or awaits. All payload validation happens upstream, before `send()` is called.
 */

import type { AgentUserMessage } from './query-contract'

export type ChatBridge = {
  /** Enqueue one user turn. No-op after `close()`. Never throws. */
  send(text: string): void
  /** Signal end-of-input; the generator returns after draining. Idempotent. */
  close(): void
  /** The generator handed to `query({ prompt })`. */
  stream(): AsyncGenerator<AgentUserMessage, void, unknown>
}

export function createChatBridge(): ChatBridge {
  const queue: AgentUserMessage[] = []
  let wake: (() => void) | null = null
  let closed = false

  return {
    send(text) {
      if (closed) return
      queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      })
      // Snapshot-and-clear before calling: the resolver runs the generator, which may re-assign
      // `wake` synchronously, and we must not clobber that newer waiter.
      const resume = wake
      wake = null
      resume?.()
    },

    close() {
      closed = true
      const resume = wake
      wake = null
      resume?.()
    },

    async *stream() {
      // A producer/consumer queue: `closed` is flipped by `close()` from outside this generator, and
      // each turn must be awaited in sequence — there is no batch to `Promise.all`. The two loop
      // lint rules assume a self-contained counting loop, which this deliberately is not.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!closed || queue.length > 0) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (closed) break
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}
