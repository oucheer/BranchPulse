import type { GitLabConnectionConfig, GitLabProject, GitLabTestResult } from '@shared/types'
import type { SettingsService } from './settings'
import { logger } from '../utils/logger'
import { decryptSecret, encryptSecret } from '../utils/secrets'

// Credential encryption lives in `utils/secrets` so the backend does not depend
// on Electron. Re-exported here because repository/settings import it from here.
export { decryptSecret, encryptSecret }

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

/** Path segments of a URL, with a trailing `.git` removed from the last one. */
export function urlPathSegments(url: string): string[] {
  const segments = new URL(normalizeUrl(url)).pathname.split('/').filter(Boolean)
  if (segments.length > 0 && segments[segments.length - 1].endsWith('.git')) {
    segments[segments.length - 1] = segments[segments.length - 1].slice(0, -4)
  }
  return segments
}

/**
 * True when the URL already names a GitLab API base (`.../api/v4`).
 *
 * Entering the API base explicitly is the escape hatch for an instance whose
 * URL layout cannot be derived from the service root, so such a URL must not be
 * mistaken for a project path. A prefix of at most one segment is allowed,
 * matching GitLab's relative URL root, which is a single level: the API is then
 * served from `<relative-root>/api/v4`. A longer prefix is a project namespace
 * that happens to end in `api`.
 *
 * A bare `.../api` (no version) is deliberately *not* accepted: it is
 * indistinguishable from the project `<namespace>/api`, and the derived
 * `<relative-root>/api/v4` form is what the UI asks users to enter.
 */
export function isApiBaseUrl(url: string): boolean {
  const segments = urlPathSegments(url).map((segment) => segment.toLowerCase())
  const last = segments.length - 1
  if (segments[last] !== 'v4' || segments[last - 1] !== 'api') return false
  return last - 1 <= 1
}

/** GitLab.com always serves its API from the root; only self-hosted can nest. */
const CLOUD_ROOTS = new Set(['gitlab.com', 'www.gitlab.com'])

/** Segments of a namespace path (`group/sub/app`), independent of any origin. */
function projectSegments(projectPath: string): string[] {
  return projectPath.split('/').filter(Boolean)
}

/**
 * Relative URL root of a self-hosted GitLab: the one path segment an instance
 * mounted at `http://host/gitlab` prefixes to every route, including the API.
 *
 * A project URL (`http://host/gitlab/group/app`) only reveals the root once the
 * project path is known, so `projectPath` is subtracted first. Without it a
 * single segment is taken as the root and anything longer is treated as a
 * namespace, where the API is assumed to live at the origin.
 */
export function apiBaseUrl(
  url: string,
  provider: 'gitlab' | 'github' | 'gitee' = 'gitlab',
  projectPath?: string
): string {
  const clean = normalizeUrl(url)
  if (provider === 'github') return 'https://api.github.com'
  if (provider === 'gitee') return 'https://gitee.com/api/v5'
  const parsed = new URL(clean)
  let segments = urlPathSegments(clean)
  const project = projectPath ? projectSegments(projectPath) : []
  // A caller that knows the project path decides how the URL is read. When the
  // URL ends with exactly that path it is a project URL even if its last segment
  // is `api`, because a project may genuinely be named that.
  const isNamedProjectUrl = project.length > 0
    && project.length <= segments.length
    && segments.slice(segments.length - project.length).join('/') === project.join('/')
  if (isNamedProjectUrl) {
    segments = segments.slice(0, segments.length - project.length)
  } else {
    // The suffix shortcuts below are for a URL that was entered by hand, where
    // no project path is available to disambiguate.
    if (clean.endsWith('/api/v4')) return clean
    if (clean.endsWith('/api')) return `${clean}/v4`
  }
  const prefix = segments.length === 1 && !CLOUD_ROOTS.has(parsed.hostname.toLowerCase())
    ? `/${segments[0]}`
    : ''
  return `${parsed.origin}${prefix}/api/v4`
}

export function projectIdOrPath(input: number | string): string {
  return encodeURIComponent(String(input))
}

/**
 * GitLab and its proxies often return a useful JSON `message` even when the
 * status text is only "Internal Server Error". Keep the response body in the
 * thrown error so the scan result and server log point at the real cause
 * instead of hiding it behind a generic 500.
 */
function apiErrorDetail(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  let detail = trimmed
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'string') {
      detail = parsed
    } else if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const candidate = record.message ?? record.error_description ?? record.error
      if (typeof candidate === 'string') detail = candidate
      else if (Array.isArray(candidate)) detail = candidate.map(String).join('; ')
      else if (candidate && typeof candidate === 'object') detail = JSON.stringify(candidate)
    }
  } catch {
    // A reverse proxy may return HTML or plain text; normalize that too.
  }
  const collapsed = detail.replace(/\s+/g, ' ').trim()
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed
}

/** Upper bound on profile lookups per scan, so a huge repository stays responsive. */
const MAX_CREATOR_EMAIL_LOOKUPS = 50

export class GitLabService {
  constructor(private readonly settings: SettingsService) {}

  private projectPathCache = new Map<string, string>()
  /** `<host>|<username>` -> public address; empty string means "looked up, none public". */
  private userEmailCache = new Map<string, string>()

  /** Cache key: the same login can exist on two hosts with different addresses. */
  private userEmailKey(username: string): string {
    const host = this.settings.get().gitlabUrl.replace(/\/+$/, '')
    return `${host}|${username.toLowerCase()}`
  }

  private resolve(config?: GitLabConnectionConfig): { url: string; token: string; provider: 'gitlab' | 'github' | 'gitee' } {
    const appSettings = this.settings.get()
    const url = normalizeUrl(config?.url?.trim() || appSettings.gitlabUrl)
    const token = (config?.apiKey?.trim() || this.settings.getGitLabToken() || '').trim()
    if (!token) throw new Error('远程仓库 API token 不能为空。')
    return { url, token, provider: detectRemoteProvider(url, config?.provider) }
  }

  private pathSegments(url: string): string[] {
    return urlPathSegments(url)
  }

  private isProjectUrl(url: string): boolean {
    // An explicit API base also has a path, but it is a service root with a
    // relative URL root, not a project: `http://host/gitlab/api/v4` must list
    // projects instead of being resolved as the project `gitlab/api/v4`.
    return !isApiBaseUrl(url) && this.pathSegments(url).length >= 2
  }

  private async request<T>(path: string, config?: GitLabConnectionConfig, init: RequestInit = {}): Promise<T> {
    const { url, token, provider } = this.resolve(config)
    // `projectPath` lets a project URL (`http://host/gitlab/group/app`) reveal the
    // instance's relative URL root, so the API call keeps its `/gitlab` prefix.
    const requestUrl = new URL(
      `${apiBaseUrl(url, provider, config?.projectPath)}${path.startsWith('/') ? path : `/${path}`}`
    )
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
      const detail = apiErrorDetail(body)
      const statusLabel = response.statusText ? ` ${response.statusText}` : ''
      const message = `Remote repository API ${response.status}${statusLabel}${detail ? `: ${detail}` : ''}`
      // Keep query strings out of the log: Gitee carries its token there.
      logger.error(`Remote repository API request failed: ${init.method ?? 'GET'} ${requestUrl.origin}${requestUrl.pathname} -> ${response.status}${statusLabel}${detail ? ` | ${detail}` : ''}`)
      throw new GitLabApiErrorImpl(
        message,
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

  /**
   * Project reference used in forge API paths.
   *
   * GitLab accepts a numeric project id and that avoids putting an encoded
   * slash (`group%2Fapp`) in the URL. Some internal reverse proxies reject or
   * mishandle `%2F` with a 500, even though GitLab itself accepts it. GitHub
   * and Gitee still address repositories by `owner/name`.
   */
  private async projectRef(projectId: number, config?: GitLabConnectionConfig): Promise<string> {
    const { provider } = this.resolve(config)
    if (provider === 'gitlab') return String(projectId)
    return this.projectPath(projectId, config)
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
      const segments = this.pathSegments(url)
      try {
        return [await this.getProjectByUrl(segments.join('/'), config)]
      } catch (err) {
        // The first attempt treated every segment as the project path, which is
        // only right when the instance is served from the origin. A 404 means it
        // may instead be mounted behind a relative URL root, so retry with the
        // first segment read as that root — `apiBaseUrl` needs it to reach
        // `<relative-root>/api/v4`.
        const projectPath = this.relativeRootProjectPath(url)
        if (!projectPath) throw err
        try {
          const project = await this.getProjectByUrl(projectPath, { ...config, url, projectPath })
          return [project]
        } catch {
          // Both readings failed, so the URL layout was not the problem. Report
          // the first attempt's error: it matches the address the user typed.
          throw err
        }
      }
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

  /**
   * The project path to retry with when a project URL may carry a relative root.
   *
   * `http://host/group/app` and a project on an instance mounted at
   * `http://host/gitlab` have the same shape, so the only way to tell them apart
   * is to ask the API. Returns what the project path would be if the first
   * segment were the instance's relative URL root, or `undefined` when the URL
   * cannot have that shape.
   *
   * At least three segments are required: a GitLab project path always contains
   * a namespace (`group/app`), so a two-segment URL is either a plain project
   * URL or a service root, never `<root>/<project>`.
   */
  private relativeRootProjectPath(url: string): string | undefined {
    const segments = this.pathSegments(url)
    if (segments.length < 3) return undefined
    return segments.slice(1).join('/')
  }

  async listBranches(projectId: number, config?: GitLabConnectionConfig): Promise<GitLabBranchDto[]> {
    const { provider } = this.resolve(config)
    const projectRef = await this.projectRef(projectId, config)
    if (provider === 'github') {
      const rows = await this.paginate(`/repos/${projectRef}/branches?per_page=100`, config)
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
      const rows = await this.paginate(`/repos/${projectRef}/branches?per_page=100`, config)
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
    const rows = await this.paginate(`/projects/${projectRef}/repository/branches?per_page=100`, config)
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
    const projectRef = await this.projectRef(projectId, config)
    if (provider === 'github' || provider === 'gitee') {
      const rows = await this.request<Array<Record<string, unknown>>>(`/repos/${projectRef}/commits?sha=${encodeURIComponent(refName)}&per_page=${perPage}&page=${page}`, config)
      return rows.map((row) => this.mapGitHubCommit(row))
    }
    const qs = new URLSearchParams({ ref_name: refName, per_page: String(perPage), page: String(page) })
    return this.request<GitLabCommitDto[]>(`/projects/${projectRef}/repository/commits?${qs.toString()}`, config)
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
    const projectRef = await this.projectRef(projectId, config)
    if (provider === 'github' || provider === 'gitee') {
      const row = await this.request<Record<string, unknown>>(
        `/repos/${projectRef}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(refName)}`,
        config
      )
      const commits = Array.isArray(row.commits) ? (row.commits as Array<Record<string, unknown>>) : []
      // GitHub returns compare commits oldest-first with merge-base at index 0.
      return commits.map((entry) => this.mapGitHubCommit(entry))
    }
    const qs = new URLSearchParams({ from: baseRef, to: refName })
    const row = await this.request<Record<string, unknown>>(
      `/projects/${projectRef}/repository/compare?${qs.toString()}`,
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
   * creator may have a name but no address. The missing address is looked up
   * from the same author's profile (`/users?username=`), which is the only
   * place GitLab exposes a mail address for an account that never committed.
   */
  async listBranchCreators(
    projectId: number,
    config?: GitLabConnectionConfig
  ): Promise<Map<string, BranchCreatorDto>> {
    const creators = new Map<string, BranchCreatorDto>()
    const { provider } = this.resolve(config)
    if (provider !== 'gitlab') return creators
    const projectRef = await this.projectRef(projectId, config)
    // Newest first. Events only cover a bounded window, so older branches may
    // simply not appear; stop early once a page comes back short.
    for (let page = 1; page <= 5; page += 1) {
      const qs = new URLSearchParams({ action: 'pushed', per_page: '100', page: String(page) })
      let rows: Array<Record<string, unknown>>
      try {
        rows = await this.request<Array<Record<string, unknown>>>(`/projects/${projectRef}/events?${qs.toString()}`, config)
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
    const missing = [...creators.values()].filter((creator) => !creator.email && creator.username)
    if (missing.length > 0) {
      const emails = await this.resolveUserEmails(missing.map((creator) => creator.username), config)
      for (const creator of creators.values()) {
        if (creator.email || !creator.username) continue
        const email = emails.get(creator.username)
        if (email) creator.email = email
      }
    }
    return creators
  }

  /**
   * Resolve the public address of forge accounts by username.
   *
   * GitLab hides `public_email` on commit and event payloads whenever the user
   * did not opt in, but the user directory still reports it (and, on instances
   * that expose it, the account `email`). Without this lookup a branch created
   * from the web UI that carries no commit has a correct creator name and no
   * way to reach them.
   *
   * Bounded on purpose: one request per distinct username per scan, cached for
   * the process lifetime, and any failure degrades to "no address" instead of
   * failing the scan.
   */
  async resolveUserEmails(
    usernames: string[],
    config?: GitLabConnectionConfig
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>()
    const { provider } = this.resolve(config)
    if (provider !== 'gitlab') return resolved
    const pending = [...new Set(usernames.map((name) => name.trim()).filter(Boolean))]
      .filter((username) => {
        const cached = this.userEmailCache.get(this.userEmailKey(username))
        if (cached === undefined) return true
        if (cached) resolved.set(username, cached)
        return false
      })
      .slice(0, MAX_CREATOR_EMAIL_LOOKUPS)
    for (const username of pending) {
      const qs = new URLSearchParams({ username })
      let rows: Array<Record<string, unknown>>
      try {
        rows = await this.request<Array<Record<string, unknown>>>(`/users?${qs.toString()}`, config)
      } catch {
        continue
      }
      const match = Array.isArray(rows)
        ? rows.find((row) => String(row.username ?? '').toLowerCase() === username.toLowerCase()) ?? rows[0]
        : undefined
      const email = String(match?.public_email ?? '').trim() || String(match?.email ?? '').trim()
      this.userEmailCache.set(this.userEmailKey(username), email)
      if (email) resolved.set(username, email)
    }
    return resolved
  }

  async getProject(projectId: number, config?: GitLabConnectionConfig): Promise<GitLabProject> {
    const { url, provider } = this.resolve(config)
    const cachedPath = this.projectPathCache.get(`${provider}:${url}:${projectId}`)
    // The cached path names the project, so it also tells `apiBaseUrl` how to
    // read the URL: for `http://host/gitlab/group/app` the project URL form only
    // resolves once `group/app` is subtracted and `/gitlab` stays as the root.
    if (cachedPath) return this.getProjectByUrl(cachedPath, { ...config, projectPath: cachedPath })
    if (provider === 'github') return this.normalizeProject(await this.request<Record<string, unknown>>(`/repositories/${projectId}`, config), provider)
    if (provider === 'gitee') return this.normalizeProject(await this.request<Record<string, unknown>>(`/repos/${projectId}`, config), provider)
    const path = `/projects/${projectIdOrPath(projectId)}`
    try {
      return this.normalizeProject(await this.request<Record<string, unknown>>(path, config), provider)
    } catch (err) {
      // Adding a project happens right after `listProjects`, but not necessarily
      // in the same session, and the cache above is in-memory. Repeat the
      // relative-root retry so an instance behind a URL root can be added even
      // when the list was never fetched.
      const projectPath = config?.projectPath ? undefined : this.relativeRootProjectPath(url)
      if (!projectPath) throw err
      const retry = { ...config, url, projectPath }
      try {
        const row = await this.request<Record<string, unknown>>(path, retry)
        return this.cacheProject(row, provider, retry)
      } catch {
        // The retry is a guess about the URL layout; when it fails too, the
        // original error is the one that matches what the user typed.
        throw err
      }
    }
  }
}

