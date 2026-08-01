/**
 * The credential vault: encrypt-at-rest in the OS keychain via Electron `safeStorage`
 * (50-agent-integration.md §4). This is the thin edge — it touches `electron` and the filesystem, so
 * the format/masking decisions live in `key-store.ts` (tested directly) and this file is covered with
 * `vi.mock('electron')` + `vi.mock('node:fs/promises')` like M2.0's protocol wiring test.
 *
 * Two slots, same rules (M2.7):
 * - **API key** → `anthropic.key.enc`, injected as `ANTHROPIC_API_KEY`.
 * - **Subscription token** → `claude.oauth.enc`, minted by `claude setup-token` and injected as
 *   `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * Separate files rather than one JSON blob so clearing one cannot corrupt or race the other, and so a
 * decrypt failure on one slot degrades to "that credential is absent" instead of losing both.
 *
 * Plaintext never leaves main: each secret is written encrypted, read back only to build the
 * subprocess env, and exposed to the renderer solely as a masked `ApiKeyStatus`.
 */

import { app, safeStorage } from 'electron'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ApiKeyStatus } from '../../shared/agent/types'
import { deriveAuthStatus, type AuthStatus } from '../../shared/agent/auth'
import { describeEndpoint } from '../../shared/agent/endpoint'
import type { AgentCredential } from './auth-env'
import { InvalidApiKeyError, isPlausibleApiKey, keyStatus, normalizeApiKey } from './key-store'

/** Raised when the OS has no encryption backend (rare Linux dev case) — we refuse to persist. */
export class KeychainUnavailableError extends Error {
  constructor(message = 'OS encryption is unavailable; the credential cannot be stored securely.') {
    super(message)
    this.name = 'KeychainUnavailableError'
  }
}

/** Which vault slot an operation targets. */
export type VaultSlot = 'api-key' | 'subscription'

const SLOT_FILES: Readonly<Record<VaultSlot, string>> = {
  'api-key': 'anthropic.key.enc',
  subscription: 'claude.oauth.enc',
}

/**
 * `safeStorage` backs onto Keychain (macOS) / DPAPI (Windows); the ciphertext is bound to the OS user
 * account. Resolved lazily so the path is read after `app` is ready.
 */
function slotPath(slot: VaultSlot): string {
  return path.join(app.getPath('userData'), SLOT_FILES[slot])
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Encrypt and persist a secret. Throws `InvalidApiKeyError` for malformed input and
 * `KeychainUnavailableError` when the OS backend is missing — both *before* anything is written.
 * Returns the masked status the renderer will display.
 */
export async function saveSecret(slot: VaultSlot, raw: string): Promise<ApiKeyStatus> {
  if (!isPlausibleApiKey(raw)) throw new InvalidApiKeyError()
  if (!isEncryptionAvailable()) throw new KeychainUnavailableError()
  const normalized = normalizeApiKey(raw)
  // Write-then-rename. The two-slot design is justified on corruption resistance — a bad write to one
  // credential must not cost the user the other — and a torn in-place write would undercut that for
  // the slot being written. `rename` within the same directory is atomic on POSIX and on Windows
  // (MoveFileEx semantics), so a crash mid-save leaves either the old credential or the new one,
  // never a half-file that decrypts to garbage.
  const target = slotPath(slot)
  const scratch = `${target}.tmp`
  await writeFile(scratch, safeStorage.encryptString(normalized))
  await rename(scratch, target)
  return keyStatus(normalized)
}

/**
 * Decrypt and return a stored secret, or `null` if none is stored or it can't be decrypted (e.g. the
 * OS user changed). Callers treat `null` as "that credential is not configured".
 */
export async function loadSecret(slot: VaultSlot): Promise<string | null> {
  try {
    const decrypted = safeStorage.decryptString(await readFile(slotPath(slot)))
    return isPlausibleApiKey(decrypted) ? normalizeApiKey(decrypted) : null
  } catch {
    return null
  }
}

/** The masked status for one slot, without exposing plaintext. */
export async function getSecretStatus(slot: VaultSlot): Promise<ApiKeyStatus> {
  return keyStatus(await loadSecret(slot))
}

/** Remove a stored secret. Idempotent — a missing file is success. */
export async function clearSecret(slot: VaultSlot): Promise<ApiKeyStatus> {
  await rm(slotPath(slot), { force: true })
  return { configured: false, last4: null }
}

// --- named wrappers: the call sites read better, and the slot strings stay in one place -----------

export const saveApiKey = (raw: string): Promise<ApiKeyStatus> => saveSecret('api-key', raw)
export const loadApiKey = (): Promise<string | null> => loadSecret('api-key')
export const getApiKeyStatus = (): Promise<ApiKeyStatus> => getSecretStatus('api-key')
export const clearApiKey = (): Promise<ApiKeyStatus> => clearSecret('api-key')

export const saveSubscriptionToken = (raw: string): Promise<ApiKeyStatus> =>
  saveSecret('subscription', raw)
export const loadSubscriptionToken = (): Promise<string | null> => loadSecret('subscription')
export const getSubscriptionTokenStatus = (): Promise<ApiKeyStatus> =>
  getSecretStatus('subscription')
export const clearSubscriptionToken = (): Promise<ApiKeyStatus> => clearSecret('subscription')

/**
 * The masked, renderer-facing view of both slots — backs `agent:authStatus`.
 *
 * Reads `ANTHROPIC_BASE_URL` on every call rather than caching it: the agent subprocess reads the
 * live environment too, so a cached value could tell the user their credential goes to Anthropic
 * while the next spawn sends it elsewhere.
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  const [apiKey, subscription] = await Promise.all([
    getApiKeyStatus(),
    getSubscriptionTokenStatus(),
  ])
  return deriveAuthStatus(apiKey, subscription, describeEndpoint(process.env['ANTHROPIC_BASE_URL']))
}

/**
 * Resolve the credential the next agent session should use, honouring the subscription-wins rule in
 * `deriveAuthStatus`. `null` means nothing is configured and the session must not start.
 *
 * Main-process only — the return value carries plaintext and must never be handed to an IPC reply.
 */
export async function loadAgentCredential(): Promise<AgentCredential | null> {
  const token = await loadSubscriptionToken()
  if (token !== null) return { kind: 'subscription', value: token }
  const key = await loadApiKey()
  if (key !== null) return { kind: 'api-key', value: key }
  return null
}
