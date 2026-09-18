import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_FOLDER = 'gitmanager'
/** Application folder used before the rename; only read by the one-time migration. */
const LEGACY_APP_FOLDER = 'branchpulse'

const DB_FILE = 'gitmanager.db'
const LEGACY_DB_FILE = 'branchpulse.db'
/** File holding the DPAPI-wrapped AES key fallback. */
export const KEY_FILE = 'gitmanager.key'
const LEGACY_KEY_FILE = 'branchpulse.key'

/**
 * Reads a `GITMANAGER_*` environment variable, falling back to the pre-rename
 * `BRANCHPULSE_*` name so existing shells, scripts and service definitions keep
 * working after the rename.
 */
function env(name: string): string | undefined {
  return process.env[`GITMANAGER_${name}`] ?? process.env[`BRANCHPULSE_${name}`]
}

/** Directory of this module, whether it runs as ESM source or a bundled build. */
function moduleDir(): string {
  try {
    const url = (import.meta as { url?: string }).url
    if (url) return path.dirname(fileURLToPath(url))
  } catch {
    /* CJS build: `import.meta` is unavailable. */
  }
  try {
    return __dirname
  } catch {
    /* ESM build: `__dirname` is unavailable. */
  }
  return process.cwd()
}

/**
 * Application root: the directory holding `package.json`, used for the renderer
 * assets, `package.json` (app version) and the sql.js wasm lookup.
 *
 * Replaces Electron's `app.getAppPath()`.
 */
export function appRoot(): string {
  const override = env('APP_ROOT')
  if (override) return path.resolve(override)
  let dir = moduleDir()
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function platformUserDataDir(folder: string): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, folder)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', folder)
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
  return path.join(configHome, folder)
}

/**
 * Per-user application data directory.
 *
 * Mirrors the former `app.getPath('userData')` so an existing desktop install
 * keeps using the same database, reports and credentials:
 * Windows `%APPDATA%\gitmanager`, macOS `~/Library/Application Support/gitmanager`,
 * Linux `$XDG_CONFIG_HOME/gitmanager`.
 */
export function userDataDir(): string {
  const override = env('USER_DATA_DIR')
  if (override) return path.resolve(override)
  return platformUserDataDir(APP_FOLDER)
}

function appDataRoot(): string {
  const dataOverride = env('DATA_DIR')
  if (dataOverride) {
    return ensureDir(path.resolve(dataOverride))
  }
  if (env('PORTABLE') === '1') {
    return path.join(appRoot(), 'data')
  }
  const root = userDataDir()
  // An explicit profile override (tests, smoke runs) means the caller owns the
  // directory: never pull the developer's real data into it.
  if (!env('USER_DATA_DIR')) migrateUserData(platformUserDataDir(LEGACY_APP_FOLDER), root)
  return path.join(root, 'data')
}

/** Written once the one-time migration has run (or been ruled out). */
const MIGRATION_MARKER = '.migrated-from-branchpulse'

/**
 * One-time migration of the application state written by the pre-rename
 * (BranchPulse) build. Only the files the app actually owns are carried over —
 * the old folder is a full Chromium profile (caches, GPU stores, network
 * journal), and copying that would waste hundreds of megabytes.
 *
 * The key stores travel with the database: without `Local State` /
 * `branchpulse.key`, every encrypted Git API token in it would decrypt to an
 * empty string. Only the key file is renamed, so the wrapped key stays valid.
 *
 * A marker file, not the presence of the new database, decides whether the
 * migration already ran: a profile that was merely created (empty schema) must
 * still pick up the real data. A pre-existing database is moved aside rather
 * than deleted, so nothing is lost if both profiles held data.
 *
 * The legacy folder is left untouched so a rollback to the old build still
 * finds its data.
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
    const legacyDb = fs.existsSync(path.join(legacyData, DB_FILE))
      ? path.join(legacyData, DB_FILE)
      : path.join(legacyData, LEGACY_DB_FILE)
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
    if (fs.existsSync(legacyKey)) fs.cpSync(legacyKey, path.join(targetRoot, KEY_FILE), { force: true })
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
    // Migration is best effort: on failure the app starts with an empty profile
    // rather than refusing to boot.
  }
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
