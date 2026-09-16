import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listFolders } from '../src-node/utils/folders'
import { listFoldersForWeb } from '../src-node/api'

let workDir: string
/** Directory the picker browses; kept apart from the profile directory. */
let scanDir: string
let previousUserData: string | undefined

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-folders-'))
  scanDir = path.join(workDir, 'scan')
  fs.mkdirSync(scanDir, { recursive: true })
  // `userDataDir()` / `dataDir()` read the environment on every call, so the
  // listing roots stay inside the temp directory instead of the real profile.
  // It lives outside `scanDir` so the data directories it creates do not show
  // up as entries of the directory under test.
  previousUserData = process.env.BRANCHPULSE_USER_DATA_DIR
  process.env.BRANCHPULSE_USER_DATA_DIR = path.join(workDir, 'profile')
})

afterEach(() => {
  if (previousUserData === undefined) delete process.env.BRANCHPULSE_USER_DATA_DIR
  else process.env.BRANCHPULSE_USER_DATA_DIR = previousUserData
  fs.rmSync(workDir, { recursive: true, force: true })
})

function make(name: string): string {
  const target = path.join(scanDir, name)
  fs.mkdirSync(target, { recursive: true })
  return target
}

function write(name: string, content = 'x'): string {
  const target = path.join(scanDir, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

describe('listFolders', () => {
  it('returns only the roots when no path is requested', () => {
    const listing = listFolders('')
    expect(listing.path).toBe('')
    expect(listing.parent).toBe('')
    expect(listing.entries).toEqual([])
    expect(listing.files).toEqual([])
    expect(listing.roots.length).toBeGreaterThan(0)
    expect(listing.roots.every((entry) => entry.name && entry.path)).toBe(true)
  })

  it('lists directories with an absolute path and a parent', () => {
    make('alpha')
    make('beta')
    write('notes.txt')

    const listing = listFolders(scanDir)
    expect(listing.path).toBe(path.resolve(scanDir))
    expect(listing.parent).toBe(path.dirname(path.resolve(scanDir)))
    expect(listing.entries.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
    expect(listing.entries[0].path).toBe(path.join(path.resolve(scanDir), 'alpha'))
  })

  it('hides files unless they are requested', () => {
    make('alpha')
    write('notes.txt')
    expect(listFolders(scanDir).files).toEqual([])
  })

  it('lists files once requested, keeping directories in both shapes', () => {
    make('alpha')
    write('notes.txt')
    const listing = listFolders(scanDir, { includeFiles: true })
    expect(listing.entries.map((entry) => entry.name)).toEqual(['alpha'])
    expect(listing.files.map((entry) => entry.name)).toEqual(['notes.txt'])
  })

  it('filters files by extension, ignoring case', () => {
    write('keep.json')
    write('keep2.JSON')
    write('drop.txt')
    // Extensions arrive here already normalised (lowercase, no dot); the HTTP
    // layer does that normalisation and is covered below.
    const listing = listFolders(scanDir, { includeFiles: true, extensions: ['json'] })
    expect(listing.files.map((entry) => entry.name)).toEqual(['keep.json', 'keep2.JSON'])
  })

  it('treats an empty extension list as "no filter"', () => {
    write('a.txt')
    write('b.json')
    const listing = listFolders(scanDir, { includeFiles: true, extensions: [] })
    expect(listing.files.map((entry) => entry.name)).toEqual(['a.txt', 'b.json'])
  })

  it('sorts naturally, so numbered names keep human order', () => {
    make('item10')
    make('item2')
    const names = listFolders(scanDir).entries.map((entry) => entry.name)
    expect(names).toEqual(['item2', 'item10'])
  })

  it('skips shell and system entries that are never selectable', () => {
    make('$Recycle.Bin')
    make('System Volume Information')
    make('visible')
    expect(listFolders(scanDir).entries.map((entry) => entry.name)).toEqual(['visible'])
  })

  it('rejects a missing directory instead of silently returning nothing', () => {
    expect(() => listFolders(path.join(scanDir, 'nope'))).toThrow(/目录不存在或不可访问/)
  })

  it('rejects a file path', () => {
    const file = write('notes.txt')
    expect(() => listFolders(file)).toThrow(/目录不存在或不可访问/)
  })

  it('exposes the data and report directories as quick locations', () => {
    const roots = listFolders('').roots.map((entry) => entry.path)
    const profile = path.resolve(workDir, 'profile')
    expect(roots).toContain(profile)
    expect(roots).toContain(path.join(profile, 'data'))
    expect(roots).toContain(path.join(profile, 'data', 'reports'))
  })
})

describe('listFoldersForWeb', () => {
  it('matches the underlying implementation', () => {
    make('alpha')
    write('notes.json')
    const options = { includeFiles: true, extensions: ['json'] }
    expect(listFoldersForWeb(scanDir, options)).toEqual(listFolders(scanDir, options))
  })

  it('works without options', () => {
    make('alpha')
    expect(listFoldersForWeb(scanDir).entries.map((entry) => entry.name)).toEqual(['alpha'])
  })
})
