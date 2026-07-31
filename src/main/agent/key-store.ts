/**
 * Pure API-key logic — validation, masking, status derivation — with no `electron` or filesystem
 * dependency, so the guards can be unit-tested (and mutation-tested) directly. The encrypt-at-rest
 * edge lives in `vault.ts`.
 */

import { MAX_API_KEY_LENGTH, type ApiKeyStatus } from '../../shared/agent/types'

/** Raised when a caller tries to store a value that cannot be a key. */
export class InvalidApiKeyError extends Error {
  constructor(message = 'The API key is empty or malformed.') {
    super(message)
    this.name = 'InvalidApiKeyError'
  }
}

/** Trim surrounding whitespace; keys are pasted and often arrive with a trailing newline. */
export function normalizeApiKey(raw: string): string {
  return raw.trim()
}

/**
 * Whether a value could be an API key worth storing. Deliberately shape-only, not a format assertion
 * against Anthropic's `sk-ant-…` prefix: a wrong-but-plausible key must reach the API and fail there
 * as a typed `auth` error (50-agent-integration.md §4), so a prefix check here would only reject
 * future key formats. What it does guard: non-string, empty-after-trim, and absurdly long input that
 * has no business being handed to `safeStorage`.
 */
export function isPlausibleApiKey(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const normalized = normalizeApiKey(raw)
  return normalized.length > 0 && normalized.length <= MAX_API_KEY_LENGTH
}

/** The last four characters, for the masked status. Empty string if the key is too short. */
export function last4(key: string): string {
  return key.length >= 4 ? key.slice(-4) : ''
}

/** The masked status for a stored (or absent) key — the only key-derived value the renderer sees. */
export function keyStatus(key: string | null): ApiKeyStatus {
  if (key === null) return { configured: false, last4: null }
  const normalized = normalizeApiKey(key)
  if (normalized.length === 0) return { configured: false, last4: null }
  return { configured: true, last4: last4(normalized) }
}
