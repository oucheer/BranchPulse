import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Opens a path with the operating system shell.
 *
 * Replaces Electron's `shell.openPath` / `shell.showItemInFolder`. The web
 * backend runs on the same machine as the browser, so reports and backup
 * folders still open in the user's file manager.
 */
export async function openPath(target: string): Promise<string> {
  return new Promise((resolve) => {
    if (!target) {
      resolve('Path is empty.')
      return
    }
    let command: string
    let args: string[]
    if (process.platform === 'win32') {
      command = 'explorer.exe'
      args = [target]
    } else if (process.platform === 'darwin') {
      command = 'open'
      args = [target]
    } else {
      command = 'xdg-open'
      args = [target]
    }
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', (err) => resolve(err.message))
      child.unref()
      // `explorer.exe` returns a non-zero exit code even on success, so the
      // spawn itself (not the exit code) is what decides whether this worked.
      resolve('')
    } catch (err) {
      resolve(err instanceof Error ? err.message : String(err))
    }
  })
}

/** Reveals a file inside its containing folder (Electron's `showItemInFolder`). */
export async function showItemInFolder(target: string): Promise<void> {
  if (!target) return
  if (!fs.existsSync(target)) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const child = spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' })
        child.on('error', () => resolve())
        child.unref()
        resolve()
      } catch {
        resolve()
      }
    })
    return
  }
  const dir = target.slice(0, target.lastIndexOf(target.includes('/') ? '/' : '\\')) || os.homedir()
  await openPath(dir)
}
