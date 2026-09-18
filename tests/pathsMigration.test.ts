import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateUserData, userDataDir } from '../src-node/utils/paths'

/**
 * The rename moved the profile from `%APPDATA%\branchpulse` to
 * `%APPDATA%\gitmanager`. These cases pin the one-time migration: what travels,
 * what is deliberately skipped, and that a second run does not redo the work.
 */
let workDir: string
let legacyRoot: string
let targetRoot: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-paths-'))
  legacyRoot = path.join(workDir, 'branchpulse')
  targetRoot = path.join(workDir, 'gitmanager')
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

function seedLegacyProfile(): void {
  fs.mkdirSync(path.join(legacyRoot, 'data', 'reports'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'data', 'backups'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'data', 'demo-repository'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'GPUCache'), { recursive: true })
  fs.writeFileSync(path.join(legacyRoot, 'data', 'branchpulse.db'), 'legacy-db')
  fs.writeFileSync(path.join(legacyRoot, 'data', 'reports', 'r1.html'), '<html>')
  fs.writeFileSync(path.join(legacyRoot, 'logs', 'branchpulse-2026-01-01.log'), 'log')
  fs.writeFileSync(path.join(legacyRoot, 'Local State'), '{"os_crypt":{}}')
  fs.writeFileSync(path.join(legacyRoot, 'branchpulse.key'), 'wrapped-key')
  fs.writeFileSync(path.join(legacyRoot, 'GPUCache', 'cache.bin'), 'noise')
}

describe('migrateUserData', () => {
  it('carries the database, reports, logs and both key stores', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, targetRoot)

    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'utf8')).toBe('legacy-db')
    expect(fs.existsSync(path.join(targetRoot, 'data', 'reports', 'r1.html'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'data', 'backups'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'data', 'demo-repository'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'logs', 'branchpulse-2026-01-01.log'))).toBe(true)
    // The DPAPI-wrapped key must keep its contents: only the file name changes,
    // otherwise every stored token decrypts to an empty string.
    expect(fs.readFileSync(path.join(targetRoot, 'gitmanager.key'), 'utf8')).toBe('wrapped-key')
    expect(fs.existsSync(path.join(targetRoot, 'Local State'))).toBe(true)
  })

  it('leaves the legacy profile in place for a rollback', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, targetRoot)
    expect(fs.readFileSync(path.join(legacyRoot, 'data', 'branchpulse.db'), 'utf8')).toBe('legacy-db')
    expect(fs.existsSync(path.join(legacyRoot, 'branchpulse.key'))).toBe(true)
  })

  it('does not copy the Chromium caches', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, targetRoot)
    expect(fs.existsSync(path.join(targetRoot, 'GPUCache'))).toBe(false)
  })

  it('replaces a profile that only holds an empty schema, keeping it aside', () => {
    seedLegacyProfile()
    fs.mkdirSync(path.join(targetRoot, 'data'), { recursive: true })
    fs.writeFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'empty-schema')

    migrateUserData(legacyRoot, targetRoot)

    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'utf8')).toBe('legacy-db')
    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db.pre-rename'), 'utf8')).toBe('empty-schema')
  })

  it('runs once: later calls leave the profile alone', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, targetRoot)
    fs.writeFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'live-db')

    migrateUserData(legacyRoot, targetRoot)

    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'utf8')).toBe('live-db')
  })

  it('marks a fresh machine so it never looks for a legacy profile again', () => {
    migrateUserData(legacyRoot, targetRoot)
    expect(fs.existsSync(path.join(targetRoot, '.migrated-from-branchpulse'))).toBe(true)
  })

  it('marks a profile without a legacy database, so nothing is retried', () => {
    fs.mkdirSync(legacyRoot, { recursive: true })
    migrateUserData(legacyRoot, targetRoot)
    expect(fs.existsSync(path.join(targetRoot, '.migrated-from-branchpulse'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'data', 'gitmanager.db'))).toBe(false)
  })

  it('is a no-op when both roots are the same directory', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, legacyRoot)
    expect(fs.existsSync(path.join(legacyRoot, 'data', 'branchpulse.db'))).toBe(true)
    expect(fs.existsSync(path.join(legacyRoot, '.migrated-from-branchpulse'))).toBe(false)
  })
})

describe('profile environment variables', () => {
  const KEYS = ['GITMANAGER_USER_DATA_DIR', 'BRANCHPULSE_USER_DATA_DIR'] as const
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('prefers the renamed variable', () => {
    process.env.GITMANAGER_USER_DATA_DIR = path.join(workDir, 'new')
    process.env.BRANCHPULSE_USER_DATA_DIR = path.join(workDir, 'old')
    expect(userDataDir()).toBe(path.resolve(workDir, 'new'))
  })

  it('still honours the pre-rename variable', () => {
    process.env.BRANCHPULSE_USER_DATA_DIR = path.join(workDir, 'old')
    expect(userDataDir()).toBe(path.resolve(workDir, 'old'))
  })
})
