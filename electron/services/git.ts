import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../utils/logger'

const execFileAsync = promisify(execFile)

export interface GitRefInfo {
  fullRef: string
  refType: 'heads' | 'remotes'
  name: string
  remote?: string
  sha: string
  committedAt: string
  authorName: string
  authorEmail: string
  subject: string
}

export interface GitPresence {
  existsLocally: boolean
  existsRemotely: boolean
  remoteName: string | null
}

export class GitExecutionError extends Error {
  technical: string
  command: string

  constructor(message: string, technical: string, command: string) {
    super(message)
    this.technical = technical
    this.command = command
  }
}

export class GitService {
  constructor(private readonly getBinary: () => string = () => 'git') {}

  private async exec(args: string[], cwd: string, timeoutMs = 90000): Promise<string> {
    const binary = this.getBinary()
    try {
      const result = await execFileAsync(binary, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 128 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      })
      return result.stdout
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
      const stderr = (e.stderr ?? e.message ?? String(e)).toString().trim()
      logger.error(`git ${args.slice(0, 4).join(' ')} failed in ${cwd}`, err)
      throw new GitExecutionError(
        'Unable to complete the Git operation. The repository may have changed or Git is unavailable.',
        stderr || String(e.message ?? e),
        `git ${args.join(' ')}`
      )
    }
  }

  async version(): Promise<string> {
    const out = await this.exec(['--version'], process.cwd())
    return out.trim()
  }

  async isGitRepository(repoPath: string): Promise<boolean> {
    if (!fs.existsSync(path.join(repoPath, '.git'))) return false
    try {
      const out = await this.exec(['rev-parse', '--show-toplevel'], repoPath)
      return out.trim().length > 0
    } catch {
      return false
    }
  }

  async currentBranch(repoPath: string): Promise<string> {
    try {
      const out = await this.exec(['branch', '--show-current'], repoPath)
      return out.trim()
    } catch {
      return ''
    }
  }

  async remotes(repoPath: string): Promise<string[]> {
    try {
      const out = await this.exec(['remote'], repoPath)
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  async defaultBranch(repoPath: string, remotes: string[]): Promise<string> {
    const candidates = ['main', 'develop', 'master']
    for (const remote of remotes) {
      try {
        const out = await this.exec(['symbolic-ref', `refs/remotes/${remote}/HEAD`], repoPath)
        const ref = out.trim()
        const match = ref.match(/refs\/remotes\/[^/]+\/(.+)$/)
        if (match) return match[1]
      } catch {
        /* try next remote */
      }
    }
    for (const cand of candidates) {
      try {
        const out = await this.exec(['rev-parse', '--verify', `${cand}`], repoPath)
        if (out.trim()) return cand
      } catch {
        /* not present */
      }
    }
    const local = await this.listRefs(repoPath, 'heads')
    return local[0]?.name ?? 'main'
  }

  async fetch(repoPath: string, progress?: (msg: string) => void): Promise<void> {
    progress?.('Fetching latest refs from remotes...')
    await this.exec(['fetch', '--all', '--prune', '--tags'], repoPath, 180000)
  }

  async listRefs(repoPath: string, refType: 'heads' | 'remotes'): Promise<GitRefInfo[]> {
    const format = [
      '%(refname)',
      '%(objectname)',
      '%(committerdate:iso8601-strict)',
      '%(authorname)',
      '%(authoremail)',
      '%(subject)'
    ].join('%00')
    const refPrefix = refType === 'heads' ? 'refs/heads' : 'refs/remotes'
    const out = await this.exec(['for-each-ref', `--format=${format}`, refPrefix], repoPath)
    const rows = out.split(/\r?\n/).filter(Boolean)
    const refs: GitRefInfo[] = []
    for (const row of rows) {
      const [fullRef, sha, committedAt, authorName, authorEmail, subject = ''] = row.split('\u0000')
      if (!fullRef || !sha) continue
      if (refType === 'remotes') {
        const m = fullRef.match(/^refs\/remotes\/([^/]+)\/(.+)$/)
        if (!m) continue
        if (m[2] === 'HEAD') continue
        refs.push({
          fullRef,
          refType,
          name: m[2],
          remote: m[1],
          sha,
          committedAt,
          authorName,
          authorEmail,
          subject
        })
      } else {
        const name = fullRef.replace(/^refs\/heads\//, '')
        refs.push({
          fullRef,
          refType,
          name,
          sha,
          committedAt,
          authorName,
          authorEmail,
          subject
        })
      }
    }
    return refs
  }

  async countCommits(repoPath: string, ref: string): Promise<number> {
    const out = await this.exec(['rev-list', '--count', ref], repoPath)
    return parseInt(out.trim() || '0', 10)
  }

  async aheadBehind(repoPath: string, base: string, branch: string): Promise<{ ahead: number; behind: number }> {
    try {
      const out = await this.exec(['rev-list', '--left-right', '--count', `${base}...${branch}`], repoPath)
      const [behind, ahead] = out.trim().split(/\s+/).map((n) => parseInt(n || '0', 10))
      return { ahead: ahead ?? 0, behind: behind ?? 0 }
    } catch {
      return { ahead: 0, behind: 0 }
    }
  }

  async mergeBase(repoPath: string, base: string, branch: string): Promise<string | null> {
    try {
      const out = await this.exec(['merge-base', base, branch], repoPath)
      return out.trim() || null
    } catch {
      return null
    }
  }

  async firstDivergentCommit(
    repoPath: string,
    base: string,
    branch: string,
    mergeBase: string | null
  ): Promise<{ sha: string; authorName: string; authorEmail: string; committedAt: string; subject: string } | null> {
    const range = mergeBase ? `${mergeBase}..${branch}` : branch
    try {
      const format = ['%H', '%an', '%ae', '%cI', '%s'].join('%00') + '%x1e'
      const out = await this.exec(['log', '--reverse', `--format=${format}`, range], repoPath)
      const first = out.split('\u001e').find(Boolean)
      if (!first) return null
      const [sha, authorName, authorEmail, committedAt, subject] = first.trim().split('\u0000')
      return { sha, authorName, authorEmail, committedAt, subject }
    } catch {
      return null
    }
  }

  async lastCommits(repoPath: string, ref: string, limit = 10): Promise<Array<{ sha: string; shortSha: string; authorName: string; authorEmail: string; committedAt: string; subject: string }>> {
    try {
      const format = ['%H', '%an', '%ae', '%cI', '%s'].join('%00') + '%x1e'
      const out = await this.exec(['log', '-n', String(limit), `--format=${format}`, ref], repoPath)
      return out
        .split('\u001e')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [sha, authorName, authorEmail, committedAt, subject] = line.split('\u0000')
          return { sha, shortSha: sha?.slice(0, 7) ?? '', authorName, authorEmail, committedAt, subject: subject ?? '' }
        })
    } catch {
      return []
    }
  }

  async refExists(repoPath: string, ref: string): Promise<boolean> {
    try {
      const out = await this.exec(['rev-parse', '--verify', '--quiet', ref], repoPath)
      return out.trim().length > 0
    } catch {
      return false
    }
  }

  async mergeStatus(
    repoPath: string,
    base: string,
    branch: string
  ): Promise<{ merged: boolean; ahead: number; behind: number }> {
    const { ahead, behind } = await this.aheadBehind(repoPath, base, branch)
    return { merged: ahead === 0, ahead, behind }
  }

  async deleteLocalBranch(repoPath: string, branch: string): Promise<void> {
    await this.exec(['branch', '-D', branch], repoPath)
  }

  async deleteRemoteBranch(repoPath: string, remote: string, branch: string): Promise<void> {
    await this.exec(['push', remote, '--delete', branch], repoPath, 120000)
  }

  async branchPresence(repoPath: string, name: string, remote?: string): Promise<GitPresence> {
    const existsLocally = await this.refExists(repoPath, `refs/heads/${name}`)
    let existsRemotely = false
    let remoteName: string | null = null
    if (remote) {
      existsRemotely = await this.refExists(repoPath, `refs/remotes/${remote}/${name}`)
      remoteName = remote
    } else {
      const remotes = await this.remotes(repoPath)
      for (const r of remotes) {
        if (await this.refExists(repoPath, `refs/remotes/${r}/${name}`)) {
          existsRemotely = true
          remoteName = r
          break
        }
      }
    }
    return { existsLocally, existsRemotely, remoteName }
  }
}
