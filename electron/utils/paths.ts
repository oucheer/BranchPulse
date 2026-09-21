import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const LEGACY_APP_FOLDER = 'branchpulse'
const DB_FILE = 'gitmanager.db'
const LEGACY_DB_FILE = 'branchpulse.db'
const KEY_FILE = 'gitmanager.key'
const LEGACY_KEY_FILE = 'branchpulse.key'
const MIGRATION_MARKER = '.migrated-from-branchpulse'

/**
 * Read a GitManager environment variable, falling back to the pre-rename
 * BranchPulse name so existing launch scripts continue to work.
 */
function env(name: string): string | undefined {
  return process.env[`GITMANAGER_${name}`] ?? process.env[`BRANCHPULSE_${name}`]
}

/**
 * One-time migration of the application state written by the pre-rename
 * (BranchPulse) build. Only owned files are carried over; Chromium caches and
 * GPU stores are deliberately skipped.
 *
 * The marker is written even when there is nothing to migrate, so a fresh
 * machine does not keep looking for an old profile on every launch.
 */
export function migrateUserData(legacyRoot: string, targetRoot: string): void {
  try {
    if (path.resolve(legacyRoot) === path.resolve(targetRoot)) return
    const marker = path.join(targetRoot, MIGRATION_MARKER)
    if (fs.existsSync(marker)) return
    if (!fs.existsSync(legacyRoot)) {
      fs.mkdirSync(targetRoot, { recursive: true })
      fs.writeFileSync(marker, `${new Date().toISOString()} no legacy profile\n`, 'utf8')
      return
    }

    const legacyData = path.join(legacyRoot, 'data')
    const legacyDbPath = path.join(legacyData, DB_FILE)
    const legacyDb = fs.existsSync(legacyDbPath) ? legacyDbPath : path.join(legacyData, LEGACY_DB_FILE)
    if (!fs.existsSync(legacyDb)) {
      fs.mkdirSync(targetRoot, { recursive: true })
      fs.writeFileSync(marker, `${new Date().toISOString()} no legacy database\n`, 'utf8')
      return
    }

    fs.mkdirSync(targetRoot, { recursive: true })
    const targetData = ensureDir(path.join(targetRoot, 'data'))
    for (const name of ['reports', 'backups', 'demo-repository']) {
      const from = path.join(legacyData, name)
      if (!fs.existsSync(from)) continue
      fs.cpSync(from, path.join(targetData, name), { recursive: true, force: true })
    }

    // Electron's safeStorage key lives in Local State on Windows. The other
    // Chromium stores are copied because they contain renderer-owned settings.
    for (const name of [
      'Local State',
      'SharedStorage',
      'Preferences',
      'Local Storage',
      'Session Storage'
    ]) {
      const from = path.join(legacyRoot, name)
      if (!fs.existsSync(from)) continue
      fs.cpSync(from, path.join(targetRoot, name), { recursive: true, force: true })
    }

    const legacyKey = path.join(legacyRoot, LEGACY_KEY_FILE)
    if (fs.existsSync(legacyKey)) {
      fs.cpSync(legacyKey, path.join(targetRoot, KEY_FILE), { force: true })
    }

    const targetDb = path.join(targetData, DB_FILE)
    if (fs.existsSync(targetDb)) {
      fs.rmSync(`${targetDb}.pre-rename`, { force: true })
      fs.renameSync(targetDb, `${targetDb}.pre-rename`)
    }
    fs.cpSync(legacyDb, targetDb, { force: true })

    const legacyLogs = path.join(legacyRoot, 'logs')
    if (fs.existsSync(legacyLogs)) {
      fs.cpSync(legacyLogs, ensureDir(path.join(targetRoot, 'logs')), { recursive: true, force: true })
    }

    fs.writeFileSync(marker, `${new Date().toISOString()} migrated from ${legacyRoot}\n`, 'utf8')
  } catch {
    // Migration must never prevent the application from starting.
  }
}

/** Resolve the profile directory, with the renamed env var taking priority. */
export function userDataDir(): string {
  const override = env('USER_DATA_DIR')
  return override ? path.resolve(override) : app.getPath('userData')
}

function appDataRoot(): string {
  const dataOverride = env('DATA_DIR')
  if (dataOverride) {
    return ensureDir(path.resolve(dataOverride))
  }
  if (env('PORTABLE') === '1') {
    return path.join(app.getAppPath(), 'data')
  }
  const root = userDataDir()
  // An explicit profile override is owned by the caller (tests and smoke runs)
  // and must not pull the developer's real profile into it.
  if (!env('USER_DATA_DIR')) {
    migrateUserData(path.join(app.getPath('appData'), LEGACY_APP_FOLDER), root)
  }
  return path.join(root, 'data')
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true })
  return p
}

export function dataDir(): string {
  return ensureDir(appDataRoot())
}

export function logsDir(): string {
  return ensureDir(path.join(appDataRoot(), '..', 'logs'))
}

export function reportsDir(): string {
  return ensureDir(path.join(dataDir(), 'reports'))
}

export function dbFile(): string {
  return path.join(dataDir(), DB_FILE)
}

export function demoRepoPath(): string {
  return path.join(dataDir(), 'demo-repository')
}
