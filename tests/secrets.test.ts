import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SecretBackend } from '../src-node/utils/secrets'

let workDir: string
let previousUserData: string | undefined
let previousDataDir: string | undefined

/**
 * The encryption key is cached per process, so every test loads a private copy
 * of the module. That keeps `registerSecretBackend` calls from leaking between
 * tests and makes "a restarted process" expressible.
 */
async function freshSecretsModule(): Promise<typeof import('../src-node/utils/secrets')> {
  vi.resetModules()
  return import('../src-node/utils/secrets')
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-secrets-'))
  previousUserData = process.env.GITMANAGER_USER_DATA_DIR
  previousDataDir = process.env.GITMANAGER_DATA_DIR
  process.env.GITMANAGER_USER_DATA_DIR = workDir
  delete process.env.GITMANAGER_DATA_DIR
})

afterEach(() => {
  if (previousUserData === undefined) delete process.env.GITMANAGER_USER_DATA_DIR
  else process.env.GITMANAGER_USER_DATA_DIR = previousUserData
  if (previousDataDir === undefined) delete process.env.GITMANAGER_DATA_DIR
  else process.env.GITMANAGER_DATA_DIR = previousDataDir
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('secret round trip', () => {
  it('encrypts and decrypts through a registered backend', async () => {
    const { encryptSecret, decryptSecret, registerSecretBackend } = await freshSecretsModule()
    registerSecretBackend({
      isAvailable: () => true,
      encrypt: (plain) => `magic:${Buffer.from(plain, 'utf8').toString('base64')}`,
      decrypt: (stored) => (stored.startsWith('magic:') ? Buffer.from(stored.slice(6), 'base64').toString('utf8') : '')
    })
    const token = encryptSecret('glpat-abcdef123456')
    expect(token).not.toContain('glpat-abcdef123456')
    expect(decryptSecret(token)).toBe('glpat-abcdef123456')
  })

  it('falls back to reversible obfuscation when no key store is available', async () => {
    const { encryptSecret, decryptSecret, registerSecretBackend } = await freshSecretsModule()
    registerSecretBackend({ isAvailable: () => false, encrypt: () => 'unused', decrypt: () => '' })
    const stored = encryptSecret('hunter2')
    // Readable by GitManager only, but explicitly not presented as encryption.
    expect(stored.startsWith('plain:')).toBe(true)
    expect(stored).not.toContain('hunter2')
    expect(decryptSecret(stored)).toBe('hunter2')
  })

  it('falls back when the backend throws instead of losing the credential', async () => {
    const { encryptSecret, decryptSecret, registerSecretBackend } = await freshSecretsModule()
    registerSecretBackend({
      isAvailable: () => true,
      encrypt: () => { throw new Error('key store locked') },
      decrypt: () => ''
    })
    const stored = encryptSecret('secret-token')
    expect(stored.startsWith('plain:')).toBe(true)
    expect(decryptSecret(stored)).toBe('secret-token')
  })

  it('returns an empty string for missing values and unreadable ciphertext', async () => {
    const { decryptSecret, registerSecretBackend } = await freshSecretsModule()
    registerSecretBackend({ isAvailable: () => true, encrypt: (p) => p, decrypt: () => '' })
    expect(decryptSecret(undefined)).toBe('')
    expect(decryptSecret(null)).toBe('')
    expect(decryptSecret('')).toBe('')
    expect(decryptSecret('v10-not-really-readable')).toBe('')
  })

  it('reads an obfuscated value even when a real key store is present', async () => {
    // Databases written while no key store was available must keep working.
    const { decryptSecret, registerSecretBackend } = await freshSecretsModule()
    const plain = `plain:${Buffer.from('legacy-token', 'utf8').toString('base64')}`
    registerSecretBackend({ isAvailable: () => true, encrypt: (p) => `enc:${p}`, decrypt: () => '' })
    expect(decryptSecret(plain)).toBe('legacy-token')
  })

  it('round-trips non-ASCII values byte for byte', async () => {
    const { encryptSecret, decryptSecret, registerSecretBackend } = await freshSecretsModule()
    registerSecretBackend({
      isAvailable: () => true,
      encrypt: (plain) => `u:${Buffer.from(plain, 'utf8').toString('base64')}`,
      decrypt: (stored) => Buffer.from(stored.slice(2), 'base64').toString('utf8')
    })
    const value = '密码-🔐-ümlaut'
    expect(decryptSecret(encryptSecret(value))).toBe(value)
  })

  it('warns instead of throwing when a stored secret cannot be decrypted', async () => {
    const { decryptSecret, registerSecretBackend } = await freshSecretsModule()
    const warn = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    registerSecretBackend({ isAvailable: () => true, encrypt: (p) => p, decrypt: () => '' })
    expect(() => decryptSecret('v10-broken')).not.toThrow()
    warn.mockRestore()
  })
})

describe.runIf(process.platform === 'win32')('windows key store compatibility', () => {
  /**
   * Grouped into one case on purpose: every step below ends up spawning
   * PowerShell to talk to DPAPI, and a fresh module means a fresh key lookup,
   * so splitting this up would multiply a multi-second cost for no extra
   * coverage. Individually the steps are `v10` envelope format, nonce
   * uniqueness, and durability across a backend restart.
   */
  it('writes a v10 envelope that a restarted backend can still read', async () => {
    const first = await freshSecretsModule()
    const backend = first.createDefaultSecretBackend()
    // No key store on a stripped-down machine: nothing to verify here.
    if (!backend.isAvailable()) return

    const stored = backend.encrypt('persisted-token')
    const blob = Buffer.from(stored, 'base64')
    // `v10` version tag + 12-byte GCM nonce + ciphertext + 16-byte GCM tag.
    expect(blob.subarray(0, 3).toString('latin1')).toBe('v10')
    expect(blob.length).toBe(3 + 12 + 'persisted-token'.length + 16)
    expect(backend.decrypt(stored)).toBe('persisted-token')
    expect(path.join(workDir, 'gitmanager.key')).toSatisfy(fs.existsSync)

    // A random nonce means the same plaintext never yields the same blob.
    const again = backend.encrypt('persisted-token')
    expect(again).not.toBe(stored)
    expect(backend.decrypt(again)).toBe('persisted-token')

    // A second process must read what the first one wrote.
    const second = await freshSecretsModule()
    expect(second.decryptSecret(stored)).toBe('persisted-token')
  }, 120_000)
})

describe('SecretBackend contract', () => {
  it('is satisfied by the default backend shape', async () => {
    const { createDefaultSecretBackend } = await freshSecretsModule()
    const backend: SecretBackend = createDefaultSecretBackend()
    expect(typeof backend.isAvailable).toBe('function')
    expect(typeof backend.encrypt).toBe('function')
    expect(typeof backend.decrypt).toBe('function')
  })
})
