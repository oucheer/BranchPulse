import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_FOLDER = 'branchpulse'

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
  const override = process.env.BRANCHPULSE_APP_ROOT
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

/**
 * Per-user application data directory.
 *
 * Mirrors the former `app.getPath('userData')` so an existing desktop install
 * keeps using the same database, reports and credentials:
 * Windows `%APPDATA%\branchpulse`, macOS `~/Library/Application Support/branchpulse`,
 * Linux `$XDG_CONFIG_HOME/branchpulse`.
 */
export function userDataDir(): string {
  const override = process.env.BRANCHPULSE_USER_DATA_DIR
  if (override) return path.resolve(override)
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, APP_FOLDER)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_FOLDER)
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
  return path.join(configHome, APP_FOLDER)
}

function appDataRoot(): string {
  if (process.env.BRANCHPULSE_DATA_DIR) {
    return ensureDir(path.resolve(process.env.BRANCHPULSE_DATA_DIR))
  }
  if (process.env.BRANCHPULSE_PORTABLE === '1') {
    return path.join(appRoot(), 'data')
  }
  return path.join(userDataDir(), 'data')
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
  return path.join(dataDir(), 'branchpulse.db')
}
