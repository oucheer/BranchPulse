import { safeStorage } from 'electron'
import type { GitLabConnectionConfig, GitLabProject, GitLabTestResult } from '@shared/types'
import type { SettingsService } from './settings'
import { logger } from '../utils/logger'

const PLAIN_PREFIX = 'plain:'

export interface GitLabBranchDto {
  name: string
  protected: boolean
  default: boolean
  merged: boolean
  developers_can_push: boolean
  developers_can_merge: boolean
  can_push: boolean
  web_url: string
  commit: {
    id: string
    short_id: string
    title: string
    created_at: string
    parent_ids: string[]
    message: string
    author_name: string
    author_email: string
    authored_date: string
    committer_name: string
    committer_email: string
    committed_date: string
    web_url: string
  }
}

export interface GitLabCommitDto {
  id: string
  short_id: string
  title: string
  message: string
  created_at: string
  authored_date: string
  committed_date: string
  author_name: string
  author_email: string
  committer_name: string
  committer_email: string
  web_url: string
}

interface GitLabApiError extends Error {
  status?: number
  body?: string
}

export class GitLabApiErrorImpl extends Error {
  status?: number
  body?: string
  constructor(message: string, status?: number, body?: string) {
    super(message)
    this.name = 'GitLabApiError'
    this.status = status
    this.body = body
  }
}

function normalizeUrl(url: string): string {
  let clean = url.trim()
  if (!clean) throw new Error('GitLab URL is required.')
  if (!/^https?:\/\//i.test(clean)) clean = `https://${clean}`
  clean = clean.replace(/\/+$/, '')
  return clean
}

export function apiBaseUrl(url: string): string {
  const clean = normalizeUrl(url)
  if (clean.endsWith('/api/v4')) return clean
  if (clean.endsWith('/api')) return `${clean}/v4`
  return `${clean}/api/v4`
}

export function projectIdOrPath(input: number | string): string {
  return encodeURIComponent(String(input).replaceAll('/', '%2F'))
}

export class GitLabService {
  constructor(private readonly settings: SettingsService) {}

  private resolve(config?: GitLabConnectionConfig): { url: string; token: string } {
    const appSettings = this.settings.get()
    const url = normalizeUrl(config?.url?.trim() || appSettings.gitlabUrl)
    const token = (config?.apiKey?.trim() || this.settings.getGitLabToken() || '').trim()
    if (!token) throw new Error('GitLab API key is required.')
    return { url, token }
  }

  private async request<T>(path: string, config?: GitLabConnectionConfig, init: RequestInit = {}): Promise<T> {
    const { url, token } = this.resolve(config)
    const full = `${apiBaseUrl(url)}${path.startsWith('/') ? path : `/${path}`}`
    const response = await fetch(full, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      }
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new GitLabApiErrorImpl(
        `GitLab API ${response.status} ${response.statusText}`,
        response.status,
        body.slice(0, 500)
      )
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  async testConnection(config?: GitLabConnectionConfig): Promise<GitLabTestResult> {
    try {
      const { url, token } = this.resolve(config)
      const version = await this.request<{ version: string }>('/version', config)
      void token
      return {
        ok: true,
        message: `Connected to GitLab ${version.version || ''}`.trim(),
        version: version.version,
        ...{ __url: url }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const technical = err instanceof GitLabApiErrorImpl && err.body ? err.body : undefined
      return { ok: false, message: 'Unable to connect to GitLab. Check URL, API key and server access.', technical }
    }
  }

  async listProjects(config?: GitLabConnectionConfig, search = ''): Promise<GitLabProject[]> {
    const qs = new URLSearchParams({
      membership: 'true',
      simple: 'false',
      per_page: '100',
      order_by: 'last_activity_at'
    })
    if (search) qs.set('search', search)
    const projects = await this.request<Array<Record<string, unknown>>>(`/projects?${qs.toString()}`, config)
    return projects.map((p) => ({
      id: Number(p.id),
      name: String(p.name ?? ''),
      pathWithNamespace: String(p.path_with_namespace ?? ''),
      webUrl: String(p.web_url ?? ''),
      defaultBranch: String(p.default_branch ?? ''),
      httpUrlToRepo: String(p.http_url_to_repo ?? ''),
      avatarUrl: (p.avatar_url as string | null) ?? null
    }))
  }

  async listBranches(projectId: number, config?: GitLabConnectionConfig): Promise<GitLabBranchDto[]> {
    const pid = projectIdOrPath(projectId)
    return this.request<GitLabBranchDto[]>(`/projects/${pid}/repository/branches?per_page=100`, config)
  }

  async listCommits(
    projectId: number,
    refName: string,
    page = 1,
    perPage = 100,
    config?: GitLabConnectionConfig
  ): Promise<GitLabCommitDto[]> {
    const pid = projectIdOrPath(projectId)
    const qs = new URLSearchParams({
      ref_name: refName,
      per_page: String(perPage),
      page: String(page)
    })
    return this.request<GitLabCommitDto[]>(`/projects/${pid}/repository/commits?${qs.toString()}`, config)
  }

  async deleteBranch(projectId: number, branch: string, config?: GitLabConnectionConfig): Promise<void> {
    const pid = projectIdOrPath(projectId)
    const encoded = encodeURIComponent(branch)
    await this.request<void>(`/projects/${pid}/repository/branches/${encoded}`, config, { method: 'DELETE' })
  }

  async getProject(projectId: number, config?: GitLabConnectionConfig): Promise<GitLabProject> {
    const pid = projectIdOrPath(projectId)
    const p = await this.request<Record<string, unknown>>(`/projects/${pid}`, config)
    return {
      id: Number(p.id),
      name: String(p.name ?? ''),
      pathWithNamespace: String(p.path_with_namespace ?? ''),
      webUrl: String(p.web_url ?? ''),
      defaultBranch: String(p.default_branch ?? ''),
      httpUrlToRepo: String(p.http_url_to_repo ?? ''),
      avatarUrl: (p.avatar_url as string | null) ?? null
    }
  }
}

export function encryptSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  logger.warn('safeStorage unavailable; storing GitLab credential obfuscated only')
  return PLAIN_PREFIX + Buffer.from(value, 'utf8').toString('base64')
}

export function decryptSecret(value: string | undefined | null): string {
  if (!value) return ''
  if (value.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  }
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return ''
  }
}

