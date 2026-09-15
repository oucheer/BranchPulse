import path from 'node:path'
import type { GitLabConnectionConfig, Repository } from '@shared/types'
import type { StorageService } from './storage'
import type { GitService } from './git'
import type { AuditService } from './audit'
import type { GitLabService } from './gitlab'
import { decryptSecret, detectRemoteProvider, encryptSecret } from './gitlab'
import { newId, nowIso } from '../utils/ids'

function rowToRepository(row: Record<string, unknown>): Repository {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    source: (row.source === 'gitlab' || row.source === 'github' || row.source === 'gitee' ? row.source : 'local'),
    remoteProjectPath: (row.remote_project_path as string | null) ?? undefined,
    gitlabUrl: (row.gitlab_url as string | null) ?? undefined,
    gitlabProjectId: row.gitlab_project_id != null ? Number(row.gitlab_project_id) : undefined,
    webUrl: (row.web_url as string | null) ?? undefined,
    currentBranch: String(row.current_branch ?? ''),
    defaultBranch: String(row.default_branch ?? ''),
    remotes: safeJsonArray(row.remotes_json),
    lastFetchAt: (row.last_fetch_at as string | null) ?? null,
    lastScanAt: (row.last_scan_at as string | null) ?? null,
    totalBranches: Number(row.total_branches ?? 0),
    createdAt: String(row.created_at)
  }
}

function safeJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export class RepositoryService {
  constructor(
    private readonly storage: StorageService,
    private readonly git: GitService,
    private readonly audit: AuditService,
    private readonly gitlab: GitLabService
  ) {}

  list(): Repository[] {
    const rows = this.storage.all<Record<string, unknown>>('SELECT * FROM repositories ORDER BY created_at ASC')
    return rows.map(rowToRepository)
  }

  get(id: string): Repository | null {
    const row = this.storage.get<Record<string, unknown>>('SELECT * FROM repositories WHERE id = ?', [id])
    return row ? rowToRepository(row) : null
  }

  async add(repoPath: string): Promise<Repository> {
    const normalized = path.resolve(String(repoPath).trim())
    const valid = await this.git.isGitRepository(normalized)
    if (!valid) {
      throw new Error('This path is not a Git repository. Choose a folder that contains a .git directory.')
    }

    const existing = this.storage.get<Record<string, unknown>>('SELECT id FROM repositories WHERE path = ? COLLATE NOCASE', [normalized])
    if (existing) {
      return this.get(String(existing.id))!
    }

    const remotes = await this.git.remotes(normalized)
    const currentBranch = await this.git.currentBranch(normalized)
    const defaultBranch = await this.git.defaultBranch(normalized, remotes)
    const repo: Repository = {
      id: newId(),
      name: path.basename(normalized),
      path: normalized,
      source: 'local',
      currentBranch,
      defaultBranch,
      remotes,
      lastFetchAt: null,
      lastScanAt: null,
      totalBranches: 0,
      createdAt: nowIso()
    }
    this.storage.insert('repositories', {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      source: 'local',
      current_branch: repo.currentBranch,
      default_branch: repo.defaultBranch,
      remotes_json: JSON.stringify(repo.remotes),
      last_fetch_at: repo.lastFetchAt,
      last_scan_at: repo.lastScanAt,
      total_branches: 0,
      created_at: repo.createdAt
    })
    this.audit.record('repository_added', { repository: repo.name, path: repo.path })
    return repo
  }

  async addGitLab(projectId: number, config?: GitLabConnectionConfig): Promise<Repository> {
    const project = await this.gitlab.getProject(projectId, config)
    const provider = detectRemoteProvider(project.webUrl, config?.provider)
    const existing = this.storage.get<Record<string, unknown>>('SELECT id FROM repositories WHERE gitlab_project_id = ? AND source = ?', [project.id, provider])
    if (existing) {
      if (config?.apiKey) {
        this.storage.update('repositories', { remote_api_key: encryptSecret(config.apiKey) }, 'id = ?', [String(existing.id)])
      }
      return this.get(String(existing.id))!
    }
    const repo: Repository = {
      id: newId(),
      name: project.pathWithNamespace || project.name,
      path: `${provider}://${project.id}`,
      source: provider,
      remoteProjectPath: project.pathWithNamespace,
      gitlabUrl: project.webUrl,
      gitlabProjectId: project.id,
      webUrl: project.webUrl,
      currentBranch: project.defaultBranch,
      defaultBranch: project.defaultBranch,
      remotes: ['origin'],
      lastFetchAt: null,
      lastScanAt: null,
      totalBranches: 0,
      createdAt: nowIso()
    }
    this.storage.insert('repositories', {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      source: provider,
      gitlab_url: repo.gitlabUrl,
      gitlab_project_id: repo.gitlabProjectId,
      remote_project_path: repo.remoteProjectPath,
      remote_api_key: config?.apiKey ? encryptSecret(config.apiKey) : null,
      web_url: repo.webUrl,
      current_branch: repo.currentBranch,
      default_branch: repo.defaultBranch,
      remotes_json: JSON.stringify(repo.remotes),
      last_fetch_at: repo.lastFetchAt,
      last_scan_at: repo.lastScanAt,
      total_branches: 0,
      created_at: repo.createdAt
    })
    this.audit.record('repository_added', { repository: repo.name, gitlabProjectId: project.id })
    return repo
  }

  getRemoteToken(id: string): string {
    const row = this.storage.get<Record<string, unknown>>('SELECT remote_api_key FROM repositories WHERE id = ?', [id])
    return decryptSecret((row?.remote_api_key as string | null) ?? '')
  }

  remove(id: string): Repository[] {
    const repo = this.get(id)
    if (!repo) return this.list()
    this.storage.transaction(() => {
      this.storage.delete('branches', 'repository_id = ?', [id])
      this.storage.delete('branch_snapshots', 'key LIKE ?', [`${id}|%`])
      this.storage.delete('repositories', 'id = ?', [id])
    })
    this.audit.record('repository_removed', { repository: repo.name, path: repo.path })
    return this.list()
  }

  update(id: string, patch: Partial<Repository>): Repository | null {
    const repo = this.get(id)
    if (!repo) return null
    const merged = { ...repo, ...patch }
    this.storage.update(
      'repositories',
      {
        name: merged.name,
        source: merged.source,
        gitlab_url: merged.gitlabUrl ?? null,
        gitlab_project_id: merged.gitlabProjectId ?? null,
        remote_project_path: merged.remoteProjectPath ?? null,
        web_url: merged.webUrl ?? null,
        current_branch: merged.currentBranch,
        default_branch: merged.defaultBranch,
        remotes_json: JSON.stringify(merged.remotes),
        last_fetch_at: merged.lastFetchAt,
        last_scan_at: merged.lastScanAt,
        total_branches: merged.totalBranches
      },
      'id = ?',
      [id]
    )
    return merged
  }
}
