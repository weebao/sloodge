/**
 * The API-key vault: encrypt-at-rest in the OS keychain via Electron `safeStorage`
 * (50-agent-integration.md §4). This is the thin edge — it touches `electron` and the filesystem at
 * module scope, so the format/masking decisions live in `key-store.ts` (tested directly) and this
 * file is covered with `vi.mock('electron')` + `vi.mock('node:fs/promises')` like M2.0's protocol
 * wiring test.
 *
 * The plaintext key never leaves main: it is written encrypted, read back only to inject into the
 * subprocess env, and exposed to the renderer solely as a masked `ApiKeyStatus`.
 */

import { app, safeStorage } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ApiKeyStatus } from '../../shared/agent/types'
import { InvalidApiKeyError, isPlausibleApiKey, keyStatus, normalizeApiKey } from './key-store'

/** Raised when the OS has no encryption backend (rare Linux dev case) — we refuse to persist. */
export class KeychainUnavailableError extends Error {
  constructor(message = 'OS encryption is unavailable; the API key cannot be stored securely.') {
    super(message)
    this.name = 'KeychainUnavailableError'
  }
}

/**
 * `safeStorage` backs onto Keychain (macOS) / DPAPI (Windows); the ciphertext is bound to the OS
 * user account. Resolved lazily so the path is read after `app` is ready.
 */
function keyFilePath(): string {
  return path.join(app.getPath('userData'), 'anthropic.key.enc')
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Encrypt and persist a key. Throws `InvalidApiKeyError` for malformed input and
 * `KeychainUnavailableError` when the OS backend is missing — both before anything is written.
 * Returns the masked status the renderer will display.
 */
export async function saveApiKey(rawKey: string): Promise<ApiKeyStatus> {
  if (!isPlausibleApiKey(rawKey)) throw new InvalidApiKeyError()
  if (!isEncryptionAvailable()) throw new KeychainUnavailableError()
  const normalized = normalizeApiKey(rawKey)
  const encrypted = safeStorage.encryptString(normalized)
  await writeFile(keyFilePath(), encrypted)
  return keyStatus(normalized)
}

/**
 * Decrypt and return the stored key, or `null` if none is stored or it can't be decrypted (e.g. the
 * OS user changed). Callers treat `null` as "no key configured".
 */
export async function loadApiKey(): Promise<string | null> {
  try {
    const encrypted = await readFile(keyFilePath())
    const decrypted = safeStorage.decryptString(encrypted)
    return isPlausibleApiKey(decrypted) ? normalizeApiKey(decrypted) : null
  } catch {
    return null
  }
}

/** The masked status without exposing plaintext — for `agent:keyStatus`. */
export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
  return keyStatus(await loadApiKey())
}

/** Remove the stored key. Idempotent — a missing file is success. */
export async function clearApiKey(): Promise<ApiKeyStatus> {
  await rm(keyFilePath(), { force: true })
  return { configured: false, last4: null }
}
