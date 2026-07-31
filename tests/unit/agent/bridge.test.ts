import { describe, expect, it } from 'vitest'
import { createChatBridge } from '../../../src/main/agent/bridge'

describe('createChatBridge', () => {
  it('wraps text into the SDK user-message shape', async () => {
    const bridge = createChatBridge()
    const gen = bridge.stream()
    bridge.send('hello')
    const step = await gen.next()
    expect(step.value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
    })
  })

  it('drains queued messages in FIFO order', async () => {
    const bridge = createChatBridge()
    const gen = bridge.stream()
    bridge.send('one')
    bridge.send('two')
    const first = await gen.next()
    const second = await gen.next()
    expect(first.done === false && first.value.message.content).toBe('one')
    expect(second.done === false && second.value.message.content).toBe('two')
  })

  it('resolves a pending consumer when a later send arrives', async () => {
    const bridge = createChatBridge()
    const gen = bridge.stream()
    // next() is awaited before any send: the generator parks on the wake promise.
    const pending = gen.next()
    bridge.send('late')
    const step = await pending
    expect(step.done).toBe(false)
    expect(step.done === false && step.value.message.content).toBe('late')
  })

  it('ends the generator on close, after draining what is queued', async () => {
    const bridge = createChatBridge()
    const gen = bridge.stream()
    bridge.send('last')
    bridge.close()
    const first = await gen.next()
    expect(first.done === false && first.value.message.content).toBe('last')
    const end = await gen.next()
    expect(end.done).toBe(true)
  })

  it('unparks a pending consumer on close', async () => {
    const bridge = createChatBridge()
    const gen = bridge.stream()
    const pending = gen.next()
    bridge.close()
    const step = await pending
    expect(step.done).toBe(true)
  })

  it('ignores send after close rather than throwing (the never-throw invariant)', async () => {
    const bridge = createChatBridge()
    const gen = bridge.stream()
    bridge.close()
    expect(() => bridge.send('dropped')).not.toThrow()
    const step = await gen.next()
    expect(step.done).toBe(true)
  })
})
