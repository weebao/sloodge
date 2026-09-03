import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'

/**
 * `vault.ts` is the `safeStorage` + filesystem edge. `electron` and `node:fs/promises` are mocked so
 * the encrypt-at-rest flow, the two refusal paths, and the never-return-plaintext contract are
 * verified without a real keychain — the format decisions themselves live in `key-store.ts` and are
 * tested there.
 */
const mocks = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString: vi.fn((b: Buffer) => b.toString().replace(/^enc:/, '')),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/ud' },
  safeStorage: {
    isEncryptionAvailable: mocks.isEncryptionAvailable,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString,
  },
}))

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  rename: mocks.rename,
  rm: mocks.rm,
}))

const vault = await import('../../../src/main/agent/vault')
const { InvalidApiKeyError } = await import('../../../src/main/agent/key-store')

// path.join, not a posix literal — `vault.ts` builds this with path.join, and the M9.0 release job
// runs this suite on windows-latest where that emits backslashes. `pnpm test:win-paths` pins it.
const KEY_FILE = path.join('/ud', 'anthropic.key.enc')

beforeEach(() => {
  mocks.isEncryptionAvailable.mockReturnValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('saveApiKey', () => {
  it('encrypts the trimmed key, writes it to the keychain-backed file, returns masked status', async () => {
    const status = await vault.saveApiKey('  sk-ant-abcW3z9\n')
    expect(mocks.encryptString).toHaveBeenCalledWith('sk-ant-abcW3z9')
    // Written to a scratch file, then atomically renamed over the target.
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `${KEY_FILE}.tmp`,
      Buffer.from('enc:sk-ant-abcW3z9'),
    )
    expect(mocks.rename).toHaveBeenCalledWith(`${KEY_FILE}.tmp`, KEY_FILE)
    expect(status).toEqual({ configured: true, last4: 'W3z9' })
  })

  it('rejects a malformed key before touching disk', async () => {
    await expect(vault.saveApiKey('   ')).rejects.toBeInstanceOf(InvalidApiKeyError)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('refuses to persist when OS encryption is unavailable', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(false)
    await expect(vault.saveApiKey('sk-ant-abcW3z9')).rejects.toThrow(/encryption is unavailable/)
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
})

describe('loadApiKey', () => {
  it('decrypts a stored key', async () => {
    mocks.readFile.mockResolvedValue(Buffer.from('enc:sk-ant-live'))
    expect(await vault.loadApiKey()).toBe('sk-ant-live')
  })

  it('returns null when no key is stored', async () => {
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(await vault.loadApiKey()).toBeNull()
  })

  it('returns null when the decrypted value is not a plausible key', async () => {
    mocks.readFile.mockResolvedValue(Buffer.from('enc:'))
    expect(await vault.loadApiKey()).toBeNull()
  })
})

describe('getApiKeyStatus', () => {
  it('returns the masked status without exposing plaintext', async () => {
    mocks.readFile.mockResolvedValue(Buffer.from('enc:sk-ant-secretW3z9'))
    const status = await vault.getApiKeyStatus()
    expect(status).toEqual({ configured: true, last4: 'W3z9' })
    expect(JSON.stringify(status)).not.toContain('secret')
  })

  it('reports not-configured when absent', async () => {
    mocks.readFile.mockRejectedValue(new Error('nope'))
    expect(await vault.getApiKeyStatus()).toEqual({ configured: false, last4: null })
  })
})

describe('clearApiKey', () => {
  it('force-removes the file and reports not-configured', async () => {
    const status = await vault.clearApiKey()
    expect(mocks.rm).toHaveBeenCalledWith(KEY_FILE, { force: true })
    expect(status).toEqual({ configured: false, last4: null })
  })
})
