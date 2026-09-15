import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FolderEntry, FolderListing, FolderListingOptions } from '@shared/types'
import { userDataDir, dataDir, reportsDir } from './paths'

export type { FolderEntry, FolderListing, FolderListingOptions }

function safeStat(target: string): fs.Stats | null {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

export function isDirectory(target: string): boolean {
  return safeStat(target)?.isDirectory() === true
}

function pushDirectory(entries: FolderEntry[], name: string, target: string): void {
  entries.push({ name, path: target })
}

export function listDrives(): FolderEntry[] {
  if (process.platform === 'win32') {
    const drives: FolderEntry[] = []
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code)
      const target = `${letter}:\\`
      if (safeStat(target)) drives.push({ name: target, path: target })
    }
    return drives
  }
  const roots: FolderEntry[] = [{ name: '/', path: '/' }]
  const home = os.homedir()
  if (home && home !== '/') roots.push({ name: home, path: home })
  const volumes = '/Volumes'
  if (process.platform === 'darwin' && isDirectory(volumes)) {
    for (const name of fs.readdirSync(volumes)) pushDirectory(roots, path.join(volumes, name), path.join(volumes, name))
  }
  return roots
}

export function quickLocations(): FolderEntry[] {
  const locations: FolderEntry[] = []
  const add = (name: string, target: string): void => {
    if (target && isDirectory(target)) locations.push({ name, path: target })
  }
  add('主目录', os.homedir())
  add('桌面', path.join(os.homedir(), 'Desktop'))
  add('文档', path.join(os.homedir(), 'Documents'))
  add('下载', path.join(os.homedir(), 'Downloads'))
  add('BranchPulse 数据目录', dataDir())
  add('BranchPulse 报告目录', reportsDir())
  add('BranchPulse 用户目录', userDataDir())
  return locations
}

/**
 * Directory browser used by the in-page folder picker, the web replacement for
 * the native `dialog.showOpenDialog`.
 */
export function listFolders(target: string, options: FolderListingOptions = {}): FolderListing {
  const requested = target.trim()
  const resolved = requested ? path.resolve(requested) : ''
  const listing: FolderListing = {
    path: resolved,
    parent: '',
    entries: [],
    files: [],
    roots: quickLocations().concat(listDrives().filter((drive) => !quickLocations().some((q) => q.path === drive.path)))
  }
  if (!resolved) return listing

  const stat = safeStat(resolved)
  if (!stat || !stat.isDirectory()) {
    throw new Error(`目录不存在或不可访问：${resolved}`)
  }

  const parent = path.dirname(resolved)
  listing.parent = parent === resolved ? '' : parent

  let names: string[] = []
  try {
    names = fs.readdirSync(resolved)
  } catch (err) {
    throw new Error(`无法读取目录：${resolved}（${err instanceof Error ? err.message : String(err)}）`)
  }

  const directories: FolderEntry[] = []
  const files: FolderEntry[] = []
  for (const name of names) {
    if (name.startsWith('$') || name === 'System Volume Information') continue
    const child = path.join(resolved, name)
    const childStat = safeStat(child)
    if (!childStat) continue
    if (childStat.isDirectory()) {
      directories.push({ name, path: child })
      continue
    }
    if (!options.includeFiles || !childStat.isFile()) continue
    if (options.extensions && options.extensions.length > 0) {
      const ext = path.extname(name).slice(1).toLowerCase()
      if (!options.extensions.includes(ext)) continue
    }
    files.push({ name, path: child })
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
  directories.sort((a, b) => collator.compare(a.name, b.name))
  files.sort((a, b) => collator.compare(a.name, b.name))
  listing.entries = directories
  listing.files = files
  return listing
}
