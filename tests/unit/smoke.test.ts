import { describe, expect, it } from 'vitest'
import {
  IPC_EVENT_CHANNELS,
  IPC_REQUEST_CHANNELS,
  isIpcEventChannel,
  isIpcRequestChannel,
} from '../../src/shared/ipc-contract'
import { createSlideId, encodeTime, isSlideId, MAX_ULID_TIME } from '../../src/shared/slide-id'

describe('ipc-contract', () => {
  it('loads and exposes non-empty runtime channel allow-lists', () => {
    expect(IPC_REQUEST_CHANNELS.length).toBeGreaterThan(0)
    expect(IPC_EVENT_CHANNELS.length).toBeGreaterThan(0)
  })

  it('accepts declared channels and rejects everything else', () => {
    expect(isIpcRequestChannel('app:ping')).toBe(true)
    expect(isIpcRequestChannel('doc:destroyEverything')).toBe(false)
    expect(isIpcEventChannel('app:menu')).toBe(true)
    expect(isIpcEventChannel('app:menu ')).toBe(false)
  })

  it('keeps request and event channel namespaces disjoint', () => {
    const overlap = IPC_REQUEST_CHANNELS.filter((channel) =>
      (IPC_EVENT_CHANNELS as readonly string[]).includes(channel),
    )
    expect(overlap).toEqual([])
  })
})

describe('slide-id', () => {
  it('generates 26-char ids that validate', () => {
    const id = createSlideId()
    expect(id).toHaveLength(26)
    expect(isSlideId(id)).toBe(true)
  })

  it('encodes time deterministically in the first 10 chars', () => {
    expect(encodeTime(0)).toBe('0000000000')
    expect(encodeTime(1)).toBe('0000000001')
    expect(encodeTime(32)).toBe('0000000010')
    expect(createSlideId(0).slice(0, 10)).toBe('0000000000')
  })

  it('sorts lexicographically by creation time', () => {
    const early = createSlideId(1_000_000_000_000)
    const late = createSlideId(1_000_000_000_001)
    expect([late, early].toSorted()).toEqual([early, late])
  })

  it('is collision-resistant within a single millisecond', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => createSlideId(1_700_000_000_000)))
    expect(ids.size).toBe(2000)
  })

  it('rejects out-of-range and malformed input', () => {
    expect(() => encodeTime(-1)).toThrow(TypeError)
    expect(() => encodeTime(MAX_ULID_TIME + 1)).toThrow(RangeError)
    expect(isSlideId('nope')).toBe(false)
    expect(isSlideId('U'.repeat(26))).toBe(false)
  })
})
