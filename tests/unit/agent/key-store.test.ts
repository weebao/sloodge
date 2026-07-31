import { describe, expect, it } from 'vitest'
import {
  isPlausibleApiKey,
  keyStatus,
  last4,
  normalizeApiKey,
} from '../../../src/main/agent/key-store'
import { MAX_API_KEY_LENGTH } from '../../../src/shared/agent/types'

describe('normalizeApiKey', () => {
  it('trims surrounding whitespace (pasted keys often carry a trailing newline)', () => {
    expect(normalizeApiKey('  sk-ant-abc\n')).toBe('sk-ant-abc')
  })
})

describe('isPlausibleApiKey', () => {
  it('accepts a non-empty trimmed string within the length bound', () => {
    expect(isPlausibleApiKey('sk-ant-anything')).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   \n'],
    ['too long', 'k'.repeat(MAX_API_KEY_LENGTH + 1)],
  ])('rejects %s', (_label, value) => {
    expect(isPlausibleApiKey(value)).toBe(false)
  })

  it('accepts exactly the maximum length', () => {
    expect(isPlausibleApiKey('k'.repeat(MAX_API_KEY_LENGTH))).toBe(true)
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('rejects %s without coercing it', (_label, value) => {
    expect(isPlausibleApiKey(value)).toBe(false)
  })
})

describe('last4', () => {
  it('returns the final four characters', () => {
    expect(last4('sk-ant-secretW3z9')).toBe('W3z9')
    expect(last4('abcd')).toBe('abcd')
  })

  it('returns empty string when shorter than four characters', () => {
    expect(last4('ab')).toBe('')
  })
})

describe('keyStatus', () => {
  it('reports not-configured for a null or blank key', () => {
    expect(keyStatus(null)).toEqual({ configured: false, last4: null })
    expect(keyStatus('   ')).toEqual({ configured: false, last4: null })
  })

  it('reports configured with the last four characters, never the key', () => {
    const status = keyStatus('sk-ant-secretW3z9')
    expect(status).toEqual({ configured: true, last4: 'W3z9' })
    expect(JSON.stringify(status)).not.toContain('secret')
  })
})
