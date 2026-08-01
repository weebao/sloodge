/**
 * The vault's second slot (M2.7): the `claude setup-token` subscription token, and the credential
 * resolution that decides which one the next agent session actually uses.
 *
 * Same mocking shape as `vault.test.ts` — `vi.hoisted` bag, `vi.mock('electron')`,
 * `vi.mock('node:fs/promises')`, then a top-level `await import` of the SUT.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`)),
  decryptString: vi.fn((buf: Buffer) => buf.toString().replace(/^enc:/, '')),
  readFile: vi.fn(),
  writeFile: vi.fn(async (_path: string, _data: unknown) => undefined),
  rm: vi.fn(async (_path: string, _options: unknown) => undefined),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/userData' },
  safeStorage: {
    isEncryptionAvailable: mocks.isEncryptionAvailable,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString,
  },
}))

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  rm: mocks.rm,
}))

const vault = await import('../../../src/main/agent/vault')

/** Back the mocked filesystem with a map so the two slots can be driven independently. */
function withFiles(files: Readonly<Record<string, string>>): void {
  mocks.readFile.mockImplementation(async (p: string) => {
    const value = files[p]
    if (value === undefined) throw new Error('ENOENT')
    return Buffer.from(`enc:${value}`)
  })
}

const KEY_FILE = '/userData/anthropic.key.enc'
const TOKEN_FILE = '/userData/claude.oauth.enc'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isEncryptionAvailable.mockReturnValue(true)
  withFiles({})
})

describe('the subscription token slot', () => {
  it('writes to its own file, so clearing one credential cannot disturb the other', () => {
    void vault.saveSubscriptionToken('sk-ant-oat01-abcd')
    expect(mocks.writeFile.mock.calls[0]?.[0]).toBe(TOKEN_FILE)
  })

  it('encrypts before writing', async () => {
    await vault.saveSubscriptionToken('sk-ant-oat01-abcd')
    expect(mocks.encryptString).toHaveBeenCalledWith('sk-ant-oat01-abcd')
    expect(String(mocks.writeFile.mock.calls[0]?.[1])).toBe('enc:sk-ant-oat01-abcd')
  })

  it('returns a masked status and never the token', async () => {
    const status = await vault.saveSubscriptionToken('sk-ant-oat01-abcd')
    expect(status).toEqual({ configured: true, last4: 'abcd' })
    expect(JSON.stringify(status)).not.toContain('sk-ant-oat01-abcd')
  })

  it('refuses to persist when the OS has no encryption backend, before writing anything', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(false)
    await expect(vault.saveSubscriptionToken('sk-ant-oat01-abcd')).rejects.toThrow(
      vault.KeychainUnavailableError,
    )
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('reports not-configured when nothing is stored', async () => {
    expect(await vault.getSubscriptionTokenStatus()).toEqual({ configured: false, last4: null })
  })

  it('reads back a stored token', async () => {
    withFiles({ [TOKEN_FILE]: 'sk-ant-oat01-abcd' })
    expect(await vault.loadSubscriptionToken()).toBe('sk-ant-oat01-abcd')
  })

  it('clears idempotently', async () => {
    expect(await vault.clearSubscriptionToken()).toEqual({ configured: false, last4: null })
    expect(mocks.rm).toHaveBeenCalledWith(TOKEN_FILE, { force: true })
  })
})

describe('getAuthStatus', () => {
  it('combines both slots and reports the active mode', async () => {
    withFiles({ [KEY_FILE]: 'sk-ant-key-wxyz', [TOKEN_FILE]: 'sk-ant-oat01-abcd' })
    const status = await vault.getAuthStatus()
    expect(status.mode).toBe('subscription')
    expect(status.apiKey).toEqual({ configured: true, last4: 'wxyz' })
    expect(status.subscription).toEqual({ configured: true, last4: 'abcd' })
  })

  it('falls back to api-key when only a key is stored', async () => {
    withFiles({ [KEY_FILE]: 'sk-ant-key-wxyz' })
    expect((await vault.getAuthStatus()).mode).toBe('api-key')
  })

  it('carries no plaintext toward the renderer', async () => {
    withFiles({ [KEY_FILE]: 'sk-ant-key-wxyz', [TOKEN_FILE]: 'sk-ant-oat01-abcd' })
    const serialized = JSON.stringify(await vault.getAuthStatus())
    expect(serialized).not.toContain('sk-ant-key-wxyz')
    expect(serialized).not.toContain('sk-ant-oat01-abcd')
  })
})

describe('loadAgentCredential', () => {
  it('returns null when nothing is configured, so the turn is refused', async () => {
    expect(await vault.loadAgentCredential()).toBeNull()
  })

  it('returns the API key when only a key is stored', async () => {
    withFiles({ [KEY_FILE]: 'sk-ant-key-wxyz' })
    expect(await vault.loadAgentCredential()).toEqual({
      kind: 'api-key',
      value: 'sk-ant-key-wxyz',
    })
  })

  /** Mirrors `deriveAuthStatus`: the token the user deliberately pasted wins over a stale key. */
  it('prefers the subscription token when both are stored', async () => {
    withFiles({ [KEY_FILE]: 'sk-ant-key-wxyz', [TOKEN_FILE]: 'sk-ant-oat01-abcd' })
    expect(await vault.loadAgentCredential()).toEqual({
      kind: 'subscription',
      value: 'sk-ant-oat01-abcd',
    })
  })

  it('falls back to the key once the token is cleared', async () => {
    withFiles({ [KEY_FILE]: 'sk-ant-key-wxyz' })
    const credential = await vault.loadAgentCredential()
    expect(credential?.kind).toBe('api-key')
  })

  it('treats an undecryptable slot as absent rather than throwing', async () => {
    mocks.readFile.mockImplementation(async (p: string) =>
      p === TOKEN_FILE ? Buffer.from('corrupt') : Buffer.from('enc:sk-ant-key-wxyz'),
    )
    mocks.decryptString.mockImplementation((buf: Buffer) => {
      const text = buf.toString()
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    })
    // The corrupt token must not strand the user: the key still resolves.
    expect(await vault.loadAgentCredential()).toEqual({
      kind: 'api-key',
      value: 'sk-ant-key-wxyz',
    })
  })
})
