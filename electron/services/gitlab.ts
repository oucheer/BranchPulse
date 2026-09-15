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

/**
 * Who created a branch. Only GitLab's project events expose this: the branch
 * and commit APIs return commits, and a branch created without any commit has
 * no commits of its own to attribute.
 */
export interface BranchCreatorDto {
  name: string
  email: string
  /** Identity on the forge, when the API exposes it. */
  username: string
  createdAt: string | null
  source: 'event'
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
  if (!clean) throw new Error('远程仓库地址不能为空。')
  if (!/^https?:\/\//i.test(clean)) clean = `https://${clean}`
  clean = clean.replace(/\/+$/, '')
  return clean
}

export function detectRemoteProvider(url: string, provider?: string): 'gitlab' | 'github' | 'gitee' {
  if (provider === 'github' || provider === 'gitee' || provider === 'gitlab') return provider
  const clean = normalizeUrl(url)
  if (/gitee\.com/i.test(clean)) return 'gitee'
  if (/github\.com|api\.github\.com/i.test(clean)) return 'github'
  return 'gitlab'
}

export function apiBaseUrl(url: string, provider: 'gitlab' | 'github' | 'gitee' = 'gitlab'): string {
  const clean = normalizeUrl(url)
  if (provider === 'github') return 'https://api.github.com'
  if (provider === 'gitee') return 'https://gitee.com/api/v5'
  if (clean.endsWith('/api/v4')) return clean
  if (clean.endsWith('/api')) return `${clean}/v4`
  return `${new URL(clean).origin}/api/v4`
}

export function projectIdOrPath(input: number | string): string {
  return encodeURIComponent(String(input).replaceAll('/', '%2F'))
}

export class GitLabService {
  constructor(private readonly settings: SettingsService) {}

  private projectPathCache = new Map<string, string>()

  private resolve(config?: GitLabConnectionConfig): { url: string; token: string; provider: 'gitlab' | 'github' | 'gitee' } {
    const appSettings = this.settings.get()
    const url = normalizeUrl(config?.url?.trim() || appSettings.gitlabUrl)
    const token = (config?.apiKey?.trim() || this.settings.getGitLabToken() || '').trim()
    if (!token) throw new Error('远程仓库 API token 不能为空。')
    return { url, token, provider: detectRemoteProvider(url, config?.provider) }
  }

  private pathSegments(url: string): string[] {
    const segments = new URL(normalizeUrl(url)).pathname.split('/').filter(Boolean)
    if (segments.length > 0 && segments[segments.length - 1].endsWith('.git')) {
      segments[segments.length - 1] = segments[segments.length - 1].slice(0, -4)
    }
    return segments
  }

  private isProjectUrl(url: string): boolean {
    return this.pathSegments(url).length >= 2
  }

  private async request<T>(path: string, config?: GitLabConnectionConfig, init: RequestInit = {}): Promise<T> {
    const { url, token, provider } = this.resolve(config)
    const requestUrl = new URL(`${apiBaseUrl(url, provider)}${path.startsWith('/') ? path : `/${path}`}`)
    if (provider === 'gitee') requestUrl.searchParams.set('access_token', token)
    const response = await fetch(requestUrl, {
      ...init,
      headers: provider === 'gitlab' ? {
        'PRIVATE-TOKEN': token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      } : provider === 'github' ? {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json'
      } : {
        Accept: 'application/json',
        ...(init.headers ?? {})
      }
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new GitLabApiErrorImpl(
        `Remote repository API ${response.status} ${response.statusText}`,
        response.status,
        body.slice(0, 500)
      )
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  async testConnection(config?: GitLabConnectionConfig): Promise<GitLabTestResult> {
    try {
      const { url, provider } = this.resolve(config)
      const result: { login?: string; version?: string } = provider === 'github'
        ? await this.request<{ login: string }>('/user', config)
        : provider === 'gitee'
          ? await this.request<{ login: string }>('/user', config)
          : await this.request<{ version: string }>('/version', config)
      return {
        ok: true,
        message: `Connected to ${provider} ${result.login ?? result.version ?? ''}`.trim(),
        version: provider === 'gitlab' ? result.version : provider
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const technical = err instanceof GitLabApiErrorImpl && err.body ? err.body : undefined
      logger.error(`Remote repository connection failed: ${message}`, technical)
      let userMessage = '无法连接远程仓库。请检查地址、token 和网络访问。'
      if (/required/i.test(message)) userMessage = message
      else if (/401|Unauthorized/i.test(message)) userMessage = 'API token 无效或认证已失效。'
      else if (/403|Forbidden/i.test(message)) userMessage = 'API token 没有访问权限。'
      else if (/404|Not Found/i.test(message)) userMessage = '远程仓库地址不正确，或该服务不支持当前 API。'
      else if (/getaddrinfo|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message)) userMessage = '远程仓库地址无法访问。请检查域名、端口和网络。'
      return { ok: false, message: userMessage, technical: technical ? `${message} | ${technical}` : message }
    }
  }

  private async projectPath(projectId: number, config?: GitLabConnectionConfig): Promise<string> {
    const { url, provider } = this.resolve(config)
    const cacheKey = `${provider}:${url}:${projectId}`
    if (config?.projectPath) {
      this.projectPathCache.set(cacheKey, config.projectPath)
      return config.projectPath
    }
    const cached = this.projectPathCache.get(cacheKey)
    if (cached) return cached
    const project = await this.getProject(projectId, config)
    this.projectPathCache.set(cacheKey, project.pathWithNamespace)
    return project.pathWithNamespace
  }

  private normalizeProject(input: Record<string, unknown>, provider: 'gitlab' | 'github' | 'gitee'): GitLabProject {
    if (provider === 'github') {
      return {
        id: Number(input.id),
        name: String(input.name ?? ''),
        pathWithNamespace: String(input.full_name ?? ''),
        webUrl: String(input.html_url ?? ''),
        defaultBranch: String(input.default_branch ?? 'main'),
        httpUrlToRepo: String(input.html_url ?? ''),
        avatarUrl: (input.owner as Record<string, unknown> | undefined)?.avatar_url as string | null ?? (input.avatar_url as string | null) ?? null
      }
    }
    if (provider === 'gitee') {
      return {
        id: Number(input.id),
        name: String(input.name ?? ''),
        pathWithNamespace: String(input.full_name ?? input.path ?? ''),
        webUrl: String(input.html_url ?? ''),
        defaultBranch: String(input.default_branch ?? 'master'),
        httpUrlToRepo: String(input.html_url ?? ''),
        avatarUrl: (input.owner as Record<string, unknown> | undefined)?.avatar_url as string | null ?? null
      }
    }
    return {
      id: Number(input.id),
      name: String(input.name ?? ''),
      pathWithNamespace: String(input.path_with_namespace ?? ''),
      webUrl: String(input.web_url ?? ''),
      defaultBranch: String(input.default_branch ?? 'main'),
      httpUrlToRepo: String(input.http_url_to_repo ?? ''),
      avatarUrl: (input.avatar_url as string | null) ?? null
    }
  }

  async listProjects(config?: GitLabConnectionConfig, search = ''): Promise<GitLabProject[]> {
    const { provider } = this.resolve(config)
    if (this.isProjectUrl(config?.url?.trim() || this.settings.get().gitlabUrl)) {
      const { url } = this.resolve(config)
      return [await this.getProjectByUrl(this.pathSegments(url).join('/'), config)]
    }
    if (provider === 'github') {
      const projects = await this.paginate('/user/repos?per_page=100&sort=pushed', config)
      return projects.map((p) => this.cacheProject(p, provider, config))
    }
    if (provider === 'gitee') {
      const projects = await this.paginate('/user/repos?per_page=100&sort=pushed', config)
      return projects.map((p) => this.cacheProject(p, provider, config))
    }
    const qs = new URLSearchParams({ membership: 'true', simple: 'false', per_page: '100', order_by: 'last_activity_at' })
    if (search) qs.set('search', search)
    const projects = await this.paginate(`/projects?${qs.toString()}`, config)
    return projects.map((p) => this.cacheProject(p, provider, config))
  }

  private cacheProject(input: Record<string, unknown>, provider: 'gitlab' | 'github' | 'gitee', config?: GitLabConnectionConfig): GitLabProject {
    const project = this.normalizeProject(input, provider)
    this.projectPathCache.set(`${provider}:${this.resolve(config).url}:${project.id}`, project.pathWithNamespace)
    return project
  }

  private async paginate(path: string, config?: GitLabConnectionConfig): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = []
    for (let page = 1; page <= 20; page += 1) {
      const separator = path.includes('?') ? '&' : '?'
      const pageRows = await this.request<Array<Record<string, unknown>>>(`${path}${separator}page=${page}`, config)
      rows.push(...pageRows)
      if (pageRows.length < 100) break
    }
    return rows
  }

  private async getProjectByUrl(path: string, config?: GitLabConnectionConfig): Promise<GitLabProject> {
    const { provider } = this.resolve(config)
    const encodedPath = provider === 'gitlab' ? encodeURIComponent(path) : path
    const row = provider === 'github'
      ? await this.request<Record<string, unknown>>(`/repos/${encodedPath}`, config)
      : provider === 'gitee'
        ? await this.request<Record<string, unknown>>(`/repos/${encodedPath}`, config)
        : await this.request<Record<string, unknown>>(`/projects/${encodedPath}`, config)
    return this.cacheProject(row, provider, config)
  }

  async listBranches(projectId: number, config?: GitLabConnectionConfig): Promise<GitLabBranchDto[]> {
    const { provider } = this.resolve(config)
    const path = await this.projectPath(projectId, config)
    const encodedPath = provider === 'gitlab' ? encodeURIComponent(path) : path
    if (provider === 'github') {
      const rows = await this.paginate(`/repos/${encodedPath}/branches?per_page=100`, config)
      return rows.map((row) => {
        const sourceCommit = ((row.commit ?? {}) as {
          sha?: string
          html_url?: string
          commit?: {
            message?: string
            author?: { name?: string; email?: string; date?: string }
            committer?: { name?: string; email?: string; date?: string }
          },
          parents?: Array<{ sha?: string }>
          _links?: { html?: string }
        })
        const authorDate = String(sourceCommit.commit?.author?.date ?? sourceCommit.commit?.committer?.date ?? '')
        const committerDate = String(sourceCommit.commit?.committer?.date ?? sourceCommit.commit?.author?.date ?? '')
        return {
          name: String(row.name ?? ''),
          protected: row.protected === true,
          default: false,
          merged: false,
          developers_can_push: false,
          developers_can_merge: false,
          can_push: false,
          web_url: String((row._links as { html?: string } | undefined)?.html ?? ''),
          commit: {
            id: String(sourceCommit.sha ?? ''),
            short_id: String(sourceCommit.sha ?? '').slice(0, 8),
            title: String(sourceCommit.commit?.message ?? '').split('\n')[0],
            created_at: authorDate,
            parent_ids: Array.isArray(sourceCommit.parents) ? sourceCommit.parents.map((parent) => String((parent as Record<string, unknown>).sha ?? '')) : [],
            message: String(sourceCommit.commit?.message ?? ''),
            author_name: String(sourceCommit.commit?.author?.name ?? ''),
            author_email: String(sourceCommit.commit?.author?.email ?? ''),
            authored_date: authorDate,
            committer_name: String(sourceCommit.commit?.committer?.name ?? ''),
            committer_email: String(sourceCommit.commit?.committer?.email ?? ''),
            committed_date: committerDate,
            web_url: String(sourceCommit.html_url ?? '')
          },
        }
      })
    }
    if (provider === 'gitee') {
      const rows = await this.paginate(`/repos/${encodedPath}/branches?per_page=100`, config)
      return rows.map((row) => {
        const sourceCommit = ((row.commit ?? {}) as {
          sha?: string
          html_url?: string
          commit?: {
            message?: string
            author?: { name?: string; email?: string; date?: string }
            committer?: { name?: string; email?: string; date?: string }
          }
          parents?: Array<{ sha?: string }>
        })
        const authorDate = String(sourceCommit.commit?.author?.date ?? sourceCommit.commit?.committer?.date ?? '')
        const committerDate = String(sourceCommit.commit?.committer?.date ?? sourceCommit.commit?.author?.date ?? '')
        return {
          name: String(row.name ?? ''),
          protected: row.protected === true,
          default: false,
          merged: false,
          developers_can_push: false,
          developers_can_merge: false,
          can_push: false,
          web_url: String(sourceCommit.html_url ?? ''),
          commit: {
            id: String(sourceCommit.sha ?? ''),
            short_id: String(sourceCommit.sha ?? '').slice(0, 8),
            title: String(sourceCommit.commit?.message ?? '').split('\n')[0],
            created_at: authorDate,
            parent_ids: Array.isArray(sourceCommit.parents) ? sourceCommit.parents.map((parent) => String((parent as Record<string, unknown>).sha ?? '')) : [],
            message: String(sourceCommit.commit?.message ?? ''),
            author_name: String(sourceCommit.commit?.author?.name ?? ''),
            author_email: String(sourceCommit.commit?.author?.email ?? ''),
            authored_date: authorDate,
            committer_name: String(sourceCommit.commit?.committer?.name ?? ''),
            committer_email: String(sourceCommit.commit?.committer?.email ?? ''),
            committed_date: committerDate,
            web_url: String(sourceCommit.html_url ?? '')
          }
        }
      })
    }
    const rows = await this.paginate(`/projects/${encodedPath}/repository/branches?per_page=100`, config)
    return rows.map((row) => ({
      name: String(row.name ?? ''),
      protected: row.protected === true,
      default: row.default === true,
      merged: row.merged === true,
      developers_can_push: row.developers_can_push === true,
      developers_can_merge: row.developers_can_merge === true,
      can_push: row.can_push === true,
      web_url: String(row.web_url ?? ''),
      commit: (row.commit ?? {}) as GitLabBranchDto['commit']
    }))
  }

  /** GitHub and Gitee return the same commit shape; map it in one place. */
  private mapGitHubCommit(row: Record<string, unknown>): GitLabCommitDto {
    const commit = (row.commit ?? {}) as Record<string, unknown>
    const author = (commit.author ?? {}) as Record<string, unknown>
    const authorDate = String(author.date ?? '')
    return {
      id: String(row.sha ?? ''),
      short_id: String(row.sha ?? '').slice(0, 8),
      title: String(commit.message ?? '').split('\n')[0],
      message: String(commit.message ?? ''),
      created_at: authorDate,
      authored_date: authorDate,
      committed_date: authorDate,
      author_name: String(author.name ?? ''),
      author_email: String(author.email ?? ''),
      committer_name: String(author.name ?? ''),
      committer_email: String(author.email ?? ''),
      web_url: String(row.html_url ?? '')
    }
  }

  async listCommits(projectId: number, refName: string, page = 1, perPage = 100, config?: GitLabConnectionConfig): Promise<GitLabCommitDto[]> {
    const { provider } = this.resolve(config)
    const path = await this.projectPath(projectId, config)
    const encodedPath = provider === 'gitlab' ? encodeURIComponent(path) : path
    if (provider === 'github' || provider === 'gitee') {
      const rows = await this.request<Array<Record<string, unknown>>>(`/repos/${encodedPath}/commits?sha=${encodeURIComponent(refName)}&per_page=${perPage}&page=${page}`, config)
      return rows.map((row) => this.mapGitHubCommit(row))
    }
    const qs = new URLSearchParams({ ref_name: refName, per_page: String(perPage), page: String(page) })
    return this.request<GitLabCommitDto[]>(`/projects/${encodedPath}/repository/commits?${qs.toString()}`, config)
  }

  /**
   * Commits that `refName` has and `baseRef` does not, ordered from the
   * merge-base forward, so index 0 is the branch's first own commit.
   */
  async compareCommits(
    projectId: number,
    baseRef: string,
    refName: string,
    config?: GitLabConnectionConfig
  ): Promise<GitLabCommitDto[]> {
    const { provider } = this.resolve(config)
    const path = await this.projectPath(projectId, config)
    const encodedPath = provider === 'gitlab' ? encodeURIComponent(path) : path
    if (provider === 'github' || provider === 'gitee') {
      const row = await this.request<Record<string, unknown>>(
        `/repos/${encodedPath}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(refName)}`,
        config
      )
      const commits = Array.isArray(row.commits) ? (row.commits as Array<Record<string, unknown>>) : []
      // GitHub returns compare commits oldest-first with merge-base at index 0.
      return commits.map((entry) => this.mapGitHubCommit(entry))
    }
    const qs = new URLSearchParams({ from: baseRef, to: refName })
    const row = await this.request<Record<string, unknown>>(
      `/projects/${encodedPath}/repository/compare?${qs.toString()}`,
      config
    )
    const commits = Array.isArray(row.commits) ? (row.commits as GitLabCommitDto[]) : []
    return commits
  }

  /**
   * GitLab only: map every branch in this project to the user who created it.
   *
   * Branch creation is a ref push, so it appears as a project event with
   * `push_data.action = 'created'` and `ref_type = 'branch'` — including when
   * the branch carries no commits at all (`commit_count = 0`). This is the only
   * way to attribute a branch that has no commits of its own: the branch and
   * commit APIs simply have nothing to report.
   *
   * Returns an empty map for providers without branch-creation events (GitHub),
   * so callers fall back to "unknown" instead of attributing the base branch's
   * last commit to the new branch.
   *
   * Note: the author's `public_email` is frequently empty, so a resolved
   * creator may have a name but no address. Callers must treat that as
   * "known name, cannot send mail" rather than guessing an address.
   */
  async listBranchCreators(
    projectId: number,
    config?: GitLabConnectionConfig
  ): Promise<Map<string, BranchCreatorDto>> {
    const creators = new Map<string, BranchCreatorDto>()
    const { provider } = this.resolve(config)
    if (provider !== 'gitlab') return creators
    const path = await this.projectPath(projectId, config)
    const encodedPath = encodeURIComponent(path)
    // Newest first. Events only cover a bounded window, so older branches may
    // simply not appear; stop early once a page comes back short.
    for (let page = 1; page <= 5; page += 1) {
      const qs = new URLSearchParams({ action: 'pushed', per_page: '100', page: String(page) })
      let rows: Array<Record<string, unknown>>
      try {
        rows = await this.request<Array<Record<string, unknown>>>(`/projects/${encodedPath}/events?${qs.toString()}`, config)
      } catch {
        return creators
      }
      if (!Array.isArray(rows) || rows.length === 0) break
      for (const row of rows) {
        const push = (row.push_data ?? {}) as Record<string, unknown>
        if (push.action !== 'created' || push.ref_type !== 'branch') continue
        const branch = String(push.ref ?? '').trim()
        if (!branch || creators.has(branch)) continue
        const author = (row.author ?? {}) as Record<string, unknown>
        const name = String(author.name ?? '').trim() || String(row.author_username ?? '').trim()
        if (!name) continue
        creators.set(branch, {
          name,
          email: String(author.public_email ?? '').trim(),
          username: String(row.author_username ?? '').trim(),
          createdAt: (row.created_at as string | null) ?? null,
          source: 'event'
        })
      }
      if (rows.length < 100) break
    }
    return creators
  }

  async deleteBranch(projectId: number, branch: string, config?: GitLabConnectionConfig): Promise<void> {
    const { provider } = this.resolve(config)
    const path = await this.projectPath(projectId, config)
    const encodedPath = provider === 'gitlab' ? encodeURIComponent(path) : path
    const encodedBranch = encodeURIComponent(branch)
    if (provider === 'github') {
      await this.request<void>(`/repos/${encodedPath}/git/refs/heads/${encodedBranch}`, config, { method: 'DELETE' })
      return
    }
    if (provider === 'gitee') {
      await this.request<void>(`/repos/${encodedPath}/branches/${encodedBranch}`, config, { method: 'DELETE' })
      return
    }
    await this.request<void>(`/projects/${encodedPath}/repository/branches/${encodedBranch}`, config, { method: 'DELETE' })
  }

  async getProject(projectId: number, config?: GitLabConnectionConfig): Promise<GitLabProject> {
    const { provider } = this.resolve(config)
    const cachedPath = this.projectPathCache.get(`${provider}:${this.resolve(config).url}:${projectId}`)
    if (cachedPath) return this.getProjectByUrl(cachedPath, config)
    if (provider === 'github') return this.normalizeProject(await this.request<Record<string, unknown>>(`/repositories/${projectId}`, config), provider)
    if (provider === 'gitee') return this.normalizeProject(await this.request<Record<string, unknown>>(`/repos/${projectId}`, config), provider)
    return this.normalizeProject(await this.request<Record<string, unknown>>(`/projects/${projectIdOrPath(projectId)}`, config), provider)
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
