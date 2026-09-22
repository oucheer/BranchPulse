import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BackupOptions, BackupRecord } from '@shared/types'
import type { StorageService } from './storage'
import type { RepositoryService } from './repository'
import type { AuditService } from './audit'
import { ensureDir } from '../utils/paths'
import { newId, nowIso } from '../utils/ids'
import { uniqueIds } from './storage'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

export class BackupService {
  constructor(
    private readonly storage: StorageService,
    private readonly repositoryService: RepositoryService,
    private readonly audit: AuditService,
    private readonly getGitBinary: () => string = () => 'git',
    private readonly defaultBackupDirectory: () => string = () => ensureDir('backups')
  ) {}

  list(repositoryIds?: string[]): BackupRecord[] {
    const scope = repositoryIds ?? this.storage.selectedRepositoryIds()
    if (scope.length === 0) return []
    const selected = new Set(uniqueIds(scope))
    return this.storage
      .all<Record<string, unknown>>('SELECT * FROM backup_records ORDER BY created_at DESC')
      .map((row) => this.toRecord(row))
      .filter((record) => selected.has(record.repositoryId))
  }

  /**
   * 逐仓备份：按顺序处理全部勾选仓库，单个仓库失败不影响后续仓库。
   */
  async startBackups(options: BackupOptions = {}): Promise<BackupRecord[]> {
    const scope = uniqueIds(options.repositoryIds ?? this.storage.selectedRepositoryIds())
    if (scope.length === 0) return []
    const targetDirectory = options.folderPath?.trim() || this.defaultBackupDirectory()
    ensureDir(targetDirectory)

    const records: BackupRecord[] = []
    for (const repositoryId of scope) {
      const repository = this.repositoryService.get(repositoryId)
      if (!repository) {
        this.audit.record('backup_failed', { repositoryId, error: 'repository_missing' }, 'failure')
        continue
      }
      // 单个仓库失败（例如没有 remote URL 或 clone 报错）不得阻断后续仓库。
      try {
        records.push(await this.startOne(repositoryId, targetDirectory))
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        records.push(this.recordFailure(repositoryId, targetDirectory, error))
      }
    }
    return records
  }

  /** 写入一条失败记录，保证逐仓备份的结果一一对应。 */
  private recordFailure(repositoryId: string, targetDirectory: string, error: string): BackupRecord {
    const repository = this.repositoryService.get(repositoryId)
    const id = newId()
    const finishedAt = nowIso()
    this.storage.insert('backup_records', {
      id,
      repository_id: repositoryId,
      repository_name: repository?.name ?? repositoryId,
      path: '',
      target_directory: targetDirectory,
      remote_url: '',
      status: 'failed',
      size_bytes: 0,
      error,
      created_at: finishedAt,
      finished_at: finishedAt
    })
    this.audit.record('backup_failed', { repository: repository?.name ?? repositoryId, error }, 'failure')
    return this.get(id)!
  }

  private async startOne(repositoryId: string, targetDirectory: string): Promise<BackupRecord> {
    const repository = this.repositoryService.get(repositoryId)
    if (!repository) throw new Error('Select a repository to back up.')

    const remoteUrl = await this.remoteUrl(repository.id)
    if (!remoteUrl) throw new Error('The selected repository has no remote URL to clone.')

    const destination = path.join(targetDirectory, `${safeName(repository.name)}_${timestamp()}.git`)
    const id = newId()
    const startedAt = nowIso()

    this.storage.insert('backup_records', {
      id,
      repository_id: repository.id,
      repository_name: repository.name,
      path: destination,
      target_directory: targetDirectory,
      remote_url: remoteUrl,
      status: 'running',
      size_bytes: 0,
      error: null,
      created_at: startedAt,
      finished_at: null
    })

    try {
      await execFileAsync(this.getGitBinary(), ['clone', '--mirror', remoteUrl, destination], {
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0'
        }
      })
      this.storage.update('backup_records', {
        status: 'success',
        size_bytes: directorySize(destination),
        error: null,
        finished_at: nowIso()
      }, 'id = ?', [id])
      this.audit.record('backup_created', { repository: repository.name, path: destination })
      return this.get(id)!
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const finishedAt = nowIso()
      await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => undefined)
      this.storage.update('backup_records', { status: 'failed', error, finished_at: finishedAt }, 'id = ?', [id])
      this.audit.record('backup_failed', { repository: repository.name, error }, 'failure')
      return this.get(id)!
    }
  }

  delete(id: string): void {
    const row = this.storage.get<Record<string, unknown>>('SELECT * FROM backup_records WHERE id = ?', [id])
    if (!row) throw new Error('Backup not found.')
    const backupPath = String(row.path)
    fs.rmSync(backupPath, { recursive: true, force: true })
    this.storage.delete('backup_records', 'id = ?', [id])
    this.audit.record('backup_deleted', { repository: String(row.repository_name), path: backupPath })
  }

  private get(id: string): BackupRecord | undefined {
    const row = this.storage.get<Record<string, unknown>>('SELECT * FROM backup_records WHERE id = ?', [id])
    return row ? this.toRecord(row) : undefined
  }

  private async remoteUrl(repositoryId: string): Promise<string> {
    const repository = this.repositoryService.get(repositoryId)
    if (!repository) return ''
    if (repository.source !== 'local' && repository.remoteProjectPath) {
      const token = this.repositoryService.getRemoteToken(repository.id)
      const provider = repository.source
      if (provider === 'gitee') return `https://oauth2:${token}@gitee.com/${repository.remoteProjectPath}.git`
      if (provider === 'github') return `https://x-access-token:${token}@github.com/${repository.remoteProjectPath}.git`
      const host = repository.webUrl || repository.gitlabUrl
      if (host) return `${new URL(host).origin}/${repository.remoteProjectPath}.git`.replace(/^https:/, `https://oauth2:${token}@`)
    }

    if (repository.path.startsWith('local://') || fs.existsSync(path.join(repository.path, '.git'))) {
      try {
        const { stdout } = await execFileAsync(this.getGitBinary(), ['remote', 'get-url', 'origin'], {
          cwd: repository.path,
          timeout: 10_000,
          windowsHide: true
        })
        return stdout.trim()
      } catch {
        return ''
      }
    }
    return repository.gitlabUrl || repository.webUrl || ''
  }

  private toRecord(row: Record<string, unknown>): BackupRecord {
    return {
      id: String(row.id),
      repositoryId: String(row.repository_id),
      repositoryName: String(row.repository_name),
      remoteUrl: String(row.remote_url),
      path: String(row.path),
      status: row.status === 'success' || row.status === 'failed' ? row.status : 'running',
      startedAt: String(row.created_at),
      finishedAt: row.status === 'running' ? null : String(row.finished_at ?? row.created_at),
      error: (row.error as string | null) ?? null
    }
  }
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'repository'
}

function timestamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function directorySize(directory: string): number {
  let size = 0
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else size += fs.statSync(entryPath).size
    }
  }
  try {
    visit(directory)
  } catch {
    return 0
  }
  return size
}
