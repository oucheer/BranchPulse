import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const electronPaths = vi.hoisted(() => ({
  appData: '',
  userData: ''
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => (name === 'appData' ? electronPaths.appData : electronPaths.userData),
    getAppPath: (): string => process.cwd()
  }
}))

import { dataDir, migrateUserData, userDataDir } from '../electron/utils/paths'

let workDir: string
let legacyRoot: string
let targetRoot: string

const PROFILE_ENV_KEYS = [
  'GITMANAGER_USER_DATA_DIR',
  'BRANCHPULSE_USER_DATA_DIR',
  'GITMANAGER_DATA_DIR',
  'BRANCHPULSE_DATA_DIR',
  'GITMANAGER_PORTABLE',
  'BRANCHPULSE_PORTABLE'
] as const

const savedEnv = new Map<string, string | undefined>()

function seedLegacyProfile(): void {
  fs.mkdirSync(path.join(legacyRoot, 'data', 'reports'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'data', 'backups'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'data', 'demo-repository'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'Local Storage'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'GPUCache'), { recursive: true })
  fs.writeFileSync(path.join(legacyRoot, 'data', 'branchpulse.db'), 'legacy-db')
  fs.writeFileSync(path.join(legacyRoot, 'data', 'reports', 'r1.html'), '<html>')
  fs.writeFileSync(path.join(legacyRoot, 'logs', 'branchpulse-2026-01-01.log'), 'log')
  fs.writeFileSync(path.join(legacyRoot, 'Local State'), '{"os_crypt":{}}')
  fs.writeFileSync(path.join(legacyRoot, 'Local Storage', 'leveldb.log'), 'storage')
  fs.writeFileSync(path.join(legacyRoot, 'branchpulse.key'), 'wrapped-key')
  fs.writeFileSync(path.join(legacyRoot, 'GPUCache', 'cache.bin'), 'noise')
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-paths-'))
  legacyRoot = path.join(workDir, 'branchpulse')
  targetRoot = path.join(workDir, 'gitmanager')
  electronPaths.appData = workDir
  electronPaths.userData = targetRoot
  for (const key of PROFILE_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of PROFILE_ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('migrateUserData', () => {
  it('carries the database, owned data, logs and both key stores', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, targetRoot)

    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'utf8')).toBe('legacy-db')
    expect(fs.existsSync(path.join(targetRoot, 'data', 'reports', 'r1.html'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'data', 'backups'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'data', 'demo-repository'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'logs', 'branchpulse-2026-01-01.log'))).toBe(true)
    expect(fs.readFileSync(path.join(targetRoot, 'gitmanager.key'), 'utf8')).toBe('wrapped-key')
    expect(fs.existsSync(path.join(targetRoot, 'Local State'))).toBe(true)
    expect(fs.existsSync(path.join(targetRoot, 'Local Storage', 'leveldb.log'))).toBe(true)
  })

  it('leaves the legacy profile in place for a rollback', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, targetRoot)
    expect(fs.readFileSync(path.join(legacyRoot, 'data', 'branchpulse.db'), 'utf8')).toBe('legacy-db')
    expect(fs.existsSync(path.join(legacyRoot, 'branchpulse.key'))).toBe(true)
  })

  it('does not copy Chromium caches', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, targetRoot)
    expect(fs.existsSync(path.join(targetRoot, 'GPUCache'))).toBe(false)
  })

  it('moves a pre-existing new database aside before copying the old one', () => {
    seedLegacyProfile()
    fs.mkdirSync(path.join(targetRoot, 'data'), { recursive: true })
    fs.writeFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'empty-schema')

    migrateUserData(legacyRoot, targetRoot)

    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'utf8')).toBe('legacy-db')
    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db.pre-rename'), 'utf8')).toBe('empty-schema')
  })

  it('runs only once', () => {
    seedLegacyProfile()
    migrateUserData(legacyRoot, targetRoot)
    fs.writeFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'live-db')

    migrateUserData(legacyRoot, targetRoot)

    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'utf8')).toBe('live-db')
  })

  it('marks a fresh machine so it never retries migration', () => {
    migrateUserData(legacyRoot, targetRoot)
    expect(fs.existsSync(path.join(targetRoot, '.migrated-from-branchpulse'))).toBe(true)
  })

  it('marks a profile without a legacy database so nothing is retried', () => {
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

describe('profile path integration', () => {
  it('migrates the default profile before returning its data directory', () => {
    seedLegacyProfile()
    expect(dataDir()).toBe(path.join(targetRoot, 'data'))
    expect(fs.readFileSync(path.join(targetRoot, 'data', 'gitmanager.db'), 'utf8')).toBe('legacy-db')
  })

  it('does not migrate a profile when the new env variable owns the directory', () => {
    seedLegacyProfile()
    process.env.GITMANAGER_USER_DATA_DIR = targetRoot
    expect(dataDir()).toBe(path.join(targetRoot, 'data'))
    expect(fs.existsSync(path.join(targetRoot, 'data', 'gitmanager.db'))).toBe(false)
  })

  it('does not migrate a profile when the legacy env variable owns the directory', () => {
    seedLegacyProfile()
    process.env.BRANCHPULSE_USER_DATA_DIR = targetRoot
    expect(dataDir()).toBe(path.join(targetRoot, 'data'))
    expect(fs.existsSync(path.join(targetRoot, 'data', 'gitmanager.db'))).toBe(false)
  })

  it('prefers the renamed user-data variable', () => {
    process.env.GITMANAGER_USER_DATA_DIR = path.join(workDir, 'new')
    process.env.BRANCHPULSE_USER_DATA_DIR = path.join(workDir, 'old')
    expect(userDataDir()).toBe(path.resolve(workDir, 'new'))
  })

  it('still honours the pre-rename user-data variable', () => {
    process.env.BRANCHPULSE_USER_DATA_DIR = path.join(workDir, 'old')
    expect(userDataDir()).toBe(path.resolve(workDir, 'old'))
  })
})
