import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

function appDataRoot(): string {
  if (process.env.BRANCHPULSE_PORTABLE === '1') {
    return path.join(app.getAppPath(), 'data')
  }
  return path.join(app.getPath('userData'), 'data')
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

export function demoRepoPath(): string {
  return path.join(dataDir(), 'demo-repository')
}
