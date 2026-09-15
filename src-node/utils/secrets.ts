import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { userDataDir } from './paths'
import { logger } from './logger'

const PLAIN_PREFIX = 'plain:'
const AES_PREFIX = 'v10'
const GCM_NONCE_LENGTH = 12
const GCM_TAG_LENGTH = 16
const DPAPI_MARKER = 'DPAPI'

/**
 * Secret storage backend.
 *
 * Mirrors the contract of Electron's `safeStorage`: when the OS key store is
 * available the ciphertext is written with the same `v10` envelope Electron
 * used, so a database written by either runtime can be read by the other.
 */
export interface SecretBackend {
  isAvailable(): boolean
  encrypt(plain: string): string
  decrypt(stored: string): string
}

function runPowerShell(script: string, payload: string): string | null {
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: payload,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000
    })
    if (result.status !== 0) return null
    const out = String(result.stdout ?? '').trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

// `Convert.ToBase64String` / `ProtectedData` handle the raw key bytes as text.
// The PowerShell snippets below are only invoked on Windows, which is also the
// only platform where Electron's safeStorage used DPAPI.
const DPAPI_UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$raw = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$plain = [Security.Cryptography.ProtectedData]::Unprotect($raw, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($plain)'
].join('; ')

const DPAPI_PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$raw = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$cipher = [Security.Cryptography.ProtectedData]::Protect($raw, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($cipher)'
].join('; ')

/**
 * Reads the AES key Chromium keeps in `Local State`, which is exactly what
 * Electron's `safeStorage` used on Windows. Reusing it lets the web backend
 * read tokens that the desktop build already encrypted.
 */
function chromiumOsCryptKey(): Buffer | null {
  if (process.platform !== 'win32') return null
  try {
    const localState = path.join(userDataDir(), 'Local State')
    if (!fs.existsSync(localState)) return null
    const parsed = JSON.parse(fs.readFileSync(localState, 'utf8')) as { os_crypt?: { encrypted_key?: string } }
    const encoded = parsed.os_crypt?.encrypted_key
    if (!encoded) return null
    const blob = Buffer.from(encoded, 'base64')
    if (blob.subarray(0, DPAPI_MARKER.length).toString('latin1') !== DPAPI_MARKER) return null
    const unprotected = runPowerShell(DPAPI_UNPROTECT_SCRIPT, blob.subarray(DPAPI_MARKER.length).toString('base64'))
    if (!unprotected) return null
    const key = Buffer.from(unprotected, 'base64')
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

/** Creates a 32-byte AES key protected by DPAPI, used when no Chromium key exists. */
function createDpapiKey(): Buffer | null {
  if (process.platform !== 'win32') return null
  const key = randomBytes(32)
  const protectedKey = runPowerShell(DPAPI_PROTECT_SCRIPT, key.toString('base64'))
  if (!protectedKey) return null
  try {
    const stored = path.join(userDataDir(), 'branchpulse.key')
    fs.writeFileSync(stored, protectedKey, 'utf8')
    return key
  } catch (err) {
    logger.warn(`Unable to persist the BranchPulse encryption key: ${String(err)}`)
    return null
  }
}

function loadDpapiKey(): Buffer | null {
  if (process.platform !== 'win32') return null
  try {
    const stored = path.join(userDataDir(), 'branchpulse.key')
    if (!fs.existsSync(stored)) return createDpapiKey()
    const protectedKey = fs.readFileSync(stored, 'utf8').trim()
    const plain = runPowerShell(DPAPI_UNPROTECT_SCRIPT, protectedKey)
    if (!plain) return null
    const key = Buffer.from(plain, 'base64')
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

let cachedKey: Buffer | null | undefined

function aesKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey
  cachedKey = chromiumOsCryptKey() ?? loadDpapiKey()
  return cachedKey
}

function aesEncrypt(key: Buffer, value: string): string {
  const nonce = randomBytes(GCM_NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from(AES_PREFIX, 'latin1'), nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
}

function aesDecrypt(key: Buffer, stored: string): string | null {
  try {
    const blob = Buffer.from(stored, 'base64')
    const nonce = blob.subarray(AES_PREFIX.length, AES_PREFIX.length + GCM_NONCE_LENGTH)
    const tag = blob.subarray(blob.length - GCM_TAG_LENGTH)
    const ciphertext = blob.subarray(AES_PREFIX.length + GCM_NONCE_LENGTH, blob.length - GCM_TAG_LENGTH)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function createDefaultSecretBackend(): SecretBackend {
  return {
    isAvailable: () => aesKey() !== null,
    encrypt: (plain) => {
      const key = aesKey()
      if (!key) throw new Error('Secret encryption backend unavailable.')
      return aesEncrypt(key, plain)
    },
    decrypt: (stored) => {
      const key = aesKey()
      if (!key) return ''
      return aesDecrypt(key, stored) ?? ''
    }
  }
}

let backend: SecretBackend = createDefaultSecretBackend()

/** Allows embedding the backend against another key store (keytar, KMS, file). */
export function registerSecretBackend(next: SecretBackend): void {
  backend = next
}

function plainEncode(value: string): string {
  return PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')
}

function plainDecode(value: string): string {
  return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
}

export function encryptSecret(value: string): string {
  try {
    if (backend.isAvailable()) return backend.encrypt(value)
  } catch (err) {
    logger.warn(`Secret encryption failed, falling back to obfuscation: ${String(err)}`)
  }
  logger.warn('Secret encryption backend unavailable; storing credential obfuscated only')
  return plainEncode(value)
}

export function decryptSecret(value: string | undefined | null): string {
  if (!value) return ''
  if (value.startsWith(PLAIN_PREFIX)) return plainDecode(value)
  const decrypted = backend.decrypt(value)
  if (decrypted) return decrypted
  logger.warn('Stored credential could not be decrypted with the current backend.')
  return ''
}
