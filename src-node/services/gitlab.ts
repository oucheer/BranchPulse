import { createHash } from 'node:crypto'
import type {
  CreatorEmailResolution,
  CreatorEmailResolutionStatus,
  CreatorEmailSource,
  GitLabConnectionConfig,
  GitLabProject,
  GitLabTestResult
} from '@shared/types'
import type { SettingsService } from './settings'
import { logger } from '../utils/logger'
import { decryptSecret, encryptSecret } from '../utils/secrets'

// Credential encryption lives in `utils/secrets` so the backend does not depend
// on Electron. Re-exported here because repository/settings import it from here.
export { decryptSecret, encryptSecret }

/**
 * Every forge request has a deadline. Without one a stalled intranet proxy can
 * leave a scan running indefinitely.
 */
const REQUEST_TIMEOUT_MS = 30_000
const CONNECTION_TEST_TIMEOUT_MS = 5_000

/** Internal gateways sometimes fail once; retry statuses that can recover. */
const MAX_TRANSIENT_RETRIES = 2
const TRANSIENT_RETRY_DELAY_MS = 250

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
    author_login?: string
    authored_date: string
    committer_name: string
    committer_email: string
    committer_login?: string
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
  /** Stable account id from the creation event, when the API exposes it. */
  userId?: number | null
  /** Same account id normalized for cached JSON. */
  accountId?: string
  createdAt: string | null
  source: 'event'
  /** Only forge-bound account data or an identity-matched commit can set this. */
  emailSource: CreatorEmailSource
  /** Filled by the resolver; optional for test fixtures and cache migration. */
  emailResolution?: CreatorEmailResolution
}

/** Compatibility view for callers that only need the branch map. */
export type BranchCreatorLookupResult = BranchCreatorLookup & {
  get(branch: string): BranchCreatorDto | undefined
  has(branch: string): boolean
  keys(): MapIterator<string>
  size: number
}

function creatorLookup(
  creators: Map<string, BranchCreatorDto>,
  events: BranchCreatorEventState
): BranchCreatorLookupResult {
  return Object.assign(creators, { creators, events })
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
  author_login?: string
  committer_name: string
  committer_email: string
  committer_login?: string
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

const PROFILE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
const PROFILE_HIDDEN_TTL_MS = 60 * 60 * 1000
const PROFILE_LOOKUP_CONCURRENCY = 6

export interface ResolvedForgeUser {
  name: string
  username: string
  accountId: string
  email: string
  source: CreatorEmailSource
  resolution: CreatorEmailResolution
}

export interface BranchCreatorEventState {
  status: 'available' | 'partial' | 'unavailable'
  retryable: boolean
  checkedAt: string
  detail?: string
}

export interface BranchCreatorLookup {
  creators: Map<string, BranchCreatorDto>
  events: BranchCreatorEventState
}

export interface ResolvedCreatorCommitEmail {
  email: string
  resolution?: CreatorEmailResolution
}

interface ProfileCacheEntry {
  value: ResolvedForgeUser
  expiresAt: number
}

interface CommitEmailCacheEntry {
  value: ResolvedCreatorCommitEmail
  expiresAt: number
}

interface CommitIdentity {
  author?: string
  committer?: string
  authorId?: string
  committerId?: string
}

function forgeUserId(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const match = raw.match(/(\d+)$/)
  return match?.[1] ?? ''
}

function creatorStatus(
  status: CreatorEmailResolutionStatus,
  retryable: boolean,
  detail?: string
): CreatorEmailResolution {
  return {
    status,
    retryable,
    checkedAt: new Date().toISOString(),
    ...(detail ? { detail } : {})
  }
}

function errorStatus(error: unknown): number | undefined {
  return error instanceof GitLabApiErrorImpl ? error.status : undefined
}

function accountLookupFailure(error: unknown): CreatorEmailResolution {
  const status = errorStatus(error)
  if (status === 401 || status === 403) {
    return creatorStatus('account-lookup-forbidden', false, status === 401 ? 'account token rejected' : 'account lookup forbidden')
  }
  if (status === 429) return creatorStatus('account-lookup-rate-limited', true, 'account lookup rate limited')
  if (status === 404) return creatorStatus('account-not-found', false, 'account not found')
  return creatorStatus('account-lookup-failed', true, status ? `account lookup returned ${status}` : 'account lookup failed')
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= values.length) return
      results[index] = await worker(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()))
  return results
}

export class GitLabService {
  constructor(private readonly settings: SettingsService) {}

  private projectPathCache = new Map<string, string>()
  /** Account profiles are scoped by host, exact account identity, and token fingerprint. */
  private userProfileCache = new Map<string, ProfileCacheEntry>()
  /** Account-bound commit emails are scoped to a project and the exact creator account. */
  private creatorCommitEmailCache = new Map<string, CommitEmailCacheEntry>()

  private userProfileKey(identity: { username?: string; accountId?: string | null }, config?: GitLabConnectionConfig): string {
    const { url, token, provider } = this.resolve(config)
    const tokenFingerprint = createHash('sha256').update(token).digest('hex').slice(0, 16)
    const account = String(identity.accountId ?? '').trim()
      || String(identity.username ?? '').trim().toLowerCase()
    return `${provider}|${url.replace(/\/+$/, '').toLowerCase()}|${tokenFingerprint}|${account}`
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

  private async request<T>(
    path: string,
    config?: GitLabConnectionConfig,
    init: RequestInit = {},
    options: { timeoutMs?: number; retries?: number } = {}
  ): Promise<T> {
    const { url, token, provider } = this.resolve(config)
    // `projectPath` lets a project URL (`http://host/gitlab/group/app`) reveal the
    // instance's relative URL root, so the API call keeps its `/gitlab` prefix.
    const requestUrl = new URL(
      `${apiBaseUrl(url, provider, config?.projectPath)}${path.startsWith('/') ? path : `/${path}`}`
    )
    if (provider === 'gitee') requestUrl.searchParams.set('access_token', token)
    // Keep query strings out of the log: Gitee carries its token there.
    const safeTarget = `${requestUrl.origin}${requestUrl.pathname}`
    // A body stream can only be read once; retain the most recent response so a
    // final retry still reports the forge's own error message.
    let lastBody = ''
    let lastDetail = ''
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.send(requestUrl, provider, token, init, safeTarget, attempt, options)
      if (!response.ok) {
        const body = await response.text().catch(() => null)
        if (body !== null) {
          lastBody = body
          lastDetail = apiErrorDetail(body)
        }
        const statusLabel = response.statusText ? ` ${response.statusText}` : ''
        const retryLimit = options.retries ?? MAX_TRANSIENT_RETRIES
        if (attempt < retryLimit && isTransientStatus(response.status)) {
          logger.warn(`Remote repository API ${response.status} at ${safeTarget}; retrying (${attempt + 1}/${retryLimit}).`)
          await delay(TRANSIENT_RETRY_DELAY_MS * (attempt + 1))
          continue
        }
        const message = `Remote repository API ${response.status}${statusLabel}${lastDetail ? `: ${lastDetail}` : ''}`
        logger.error(`Remote repository API request failed: ${init.method ?? 'GET'} ${safeTarget} -> ${response.status}${statusLabel}${lastDetail ? ` | ${lastDetail}` : ''}`)
        throw new GitLabApiErrorImpl(message, response.status, lastBody.slice(0, 500))
      }
      if (response.status === 204) return undefined as T
      return (await response.json()) as T
    }
  }

  /** One attempt with a deadline, retrying dropped intranet connections. */
  private async send(
    requestUrl: URL,
    provider: 'gitlab' | 'github' | 'gitee',
    token: string,
    init: RequestInit,
    safeTarget: string,
    attempt: number,
    options: { timeoutMs?: number; retries?: number }
  ): Promise<Response> {
    try {
      return await fetch(requestUrl, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
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
    } catch (err) {
      const retryLimit = options.retries ?? MAX_TRANSIENT_RETRIES
      if (attempt < retryLimit) {
        const reason = err instanceof Error ? err.message : String(err)
        logger.warn(`Remote repository API request to ${safeTarget} failed (${reason}); retrying (${attempt + 1}/${retryLimit}).`)
        await delay(TRANSIENT_RETRY_DELAY_MS * (attempt + 1))
        return this.send(requestUrl, provider, token, init, safeTarget, attempt + 1, options)
      }
      throw err
    }
  }

  async testConnection(config?: GitLabConnectionConfig): Promise<GitLabTestResult> {
    try {
      const { url, provider } = this.resolve(config)
      const projectUrl = this.isProjectUrl(url)
      const testOptions = { timeoutMs: CONNECTION_TEST_TIMEOUT_MS, retries: 0 }
      const projectPath = this.pathSegments(url).join('/')
      const result = (provider === 'github' && projectUrl
        ? await this.request(`/repos/${projectPath}`, config, {}, testOptions)
        : provider === 'github'
          ? await this.request('/user', config, {}, testOptions)
          : provider === 'gitee' && projectUrl
            ? await this.request(`/repos/${projectPath}`, config, {}, testOptions)
            : provider === 'gitee'
              ? await this.request('/user', config, {}, testOptions)
              : await this.request('/version', config, {}, testOptions)) as Record<string, unknown>
      return {
        ok: true,
        message: `Connected to ${provider} ${String(result.login ?? result.full_name ?? result.path_with_namespace ?? result.version ?? '')}`.trim(),
        version: provider === 'gitlab' ? String(result.version ?? '') : provider
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
      // A gateway can wrap an error in a 200 response. Spreading that object
      // either crashes with an opaque exception or creates a false empty scan.
      if (pageRows === null || pageRows === undefined) break
      if (!Array.isArray(pageRows)) {
        throw new Error(`远程仓库 API 返回了非列表数据（${path}，第 ${page} 页），已中止本次扫描以免误报 0 个分支。`)
      }
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
            author?: { name?: string; email?: string; date?: string; login?: string }
            committer?: { name?: string; email?: string; date?: string; login?: string }
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
            author_login: String((row as Record<string, unknown>).author && ((row.author as Record<string, unknown>).login ?? '') || ''),
            authored_date: authorDate,
            committer_name: String(sourceCommit.commit?.committer?.name ?? ''),
            committer_email: String(sourceCommit.commit?.committer?.email ?? ''),
            committer_login: String((row as Record<string, unknown>).committer && ((row.committer as Record<string, unknown>).login ?? '') || ''),
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
            author?: { name?: string; email?: string; date?: string; login?: string }
            committer?: { name?: string; email?: string; date?: string; login?: string }
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
            author_login: String((row as Record<string, unknown>).author && ((row.author as Record<string, unknown>).login ?? '') || ''),
            authored_date: authorDate,
            committer_name: String(sourceCommit.commit?.committer?.name ?? ''),
            committer_email: String(sourceCommit.commit?.committer?.email ?? ''),
            committer_login: String((row as Record<string, unknown>).committer && ((row.committer as Record<string, unknown>).login ?? '') || ''),
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
    const authorAccount = (row.author ?? {}) as Record<string, unknown>
    const committerAccount = (row.committer ?? {}) as Record<string, unknown>
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
      author_login: String(authorAccount.login ?? authorAccount.username ?? ''),
      committer_login: String(committerAccount.login ?? committerAccount.username ?? ''),
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
    let row: Record<string, unknown>
    try {
      row = await this.request<Record<string, unknown>>(
        `/projects/${projectRef}/repository/compare?${qs.toString()}`,
        config
      )
    } catch (err) {
      // Some intranet GitLab deployments return 500 for this endpoint even when
      // the branch exists (often the reverse proxy or an old GitLab version).
      // Losing creator attribution for those branches is better than failing the
      // whole scan, so degrade to an empty diff and let the creation-event
      // lookup answer who started the branch.
      const status = err instanceof GitLabApiErrorImpl ? err.status : undefined
      if (status === 500) {
        logger.warn(`Compare endpoint returned 500 for project ${projectRef} (${baseRef}...${refName}); continuing without own-commit attribution.`)
        return []
      }
      throw err
    }
    const commits = Array.isArray(row.commits) ? (row.commits as GitLabCommitDto[]) : []
    return commits
  }

  /**
   * Resolve a creator email from a commit only when GitLab's API binds that
   * commit to the already verified creator username.
   *
   * GitLab's REST commit payload exposes the commit email but usually omits the
   * account login. Its GraphQL commit connection exposes author/committer
   * usernames, so pair the two by SHA. A display-name match is never accepted.
   */
  async resolveCreatorCommitEmail(
    projectId: number,
    _branchName: string,
    creator: { username?: string; accountId?: string; emailResolution?: CreatorEmailResolution },
    commits: GitLabCommitDto[],
    config?: GitLabConnectionConfig
  ): Promise<ResolvedCreatorCommitEmail> {
    const { url, token, provider } = this.resolve(config)
    const username = String(creator.username ?? '').trim()
    const accountId = forgeUserId(creator.accountId)
    if (provider !== 'gitlab' || (!username && !accountId) || creator.emailResolution?.status !== 'account-email-hidden') {
      return { email: '' }
    }
    const tokenFingerprint = createHash('sha256').update(token).digest('hex').slice(0, 16)
    // The account-wide commit proof is independent of a single branch. Sharing
    // this cache keeps every branch created by the same forge account in sync.
    const cacheKey = [
      'creator-email-v4',
      provider,
      url.replace(/\/+$/, '').toLowerCase(),
      tokenFingerprint,
      projectId,
      creator.accountId || username.toLowerCase()
    ].join('|')
    const cached = this.creatorCommitEmailCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const expectedUsername = username.toLowerCase()
    const matchesCreator = (login: unknown, id: unknown): boolean => {
      const resolvedId = forgeUserId(id)
      if (accountId && resolvedId) return resolvedId === accountId
      return Boolean(expectedUsername && String(login ?? '').trim().toLowerCase() === expectedUsername)
    }
    let lastLookupError: unknown
    const checkedShas = new Set<string>()
    const findBoundEmail = async (candidates: GitLabCommitDto[]): Promise<string> => {
      const ordered = [...candidates]
        .filter((commit) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(commit.author_email ?? '').trim())
          || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(commit.committer_email ?? '').trim()))
        // Keep the forge's newest-first order. A creator's current commit email
        // is normally on the newest commit, and sorting backwards paid up to 100
        // GraphQL lookups before checking the most likely match.
        .filter((commit) => {
          const sha = String(commit.id ?? '').trim()
          if (!sha || checkedShas.has(sha)) return false
          checkedShas.add(sha)
          return true
        })
      for (let offset = 0; offset < ordered.length; offset += 100) {
        const batch = ordered.slice(offset, offset + 100)
        let identities: Map<string, CommitIdentity>
        try {
          identities = await this.graphqlCommitIdentities(projectId, batch.map((commit) => String(commit.id)), config)
        } catch (error) {
          lastLookupError = error
          return ''
        }
        for (const commit of batch) {
          const identity = identities.get(String(commit.id ?? ''))
          const authorEmail = String(commit.author_email ?? '').trim()
          const committerEmail = String(commit.committer_email ?? '').trim()
          if (matchesCreator(identity?.author, identity?.authorId) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
            return authorEmail
          }
          if (matchesCreator(identity?.committer, identity?.committerId) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(committerEmail)) {
            return committerEmail
          }
        }
      }
      return ''
    }

    let email = await findBoundEmail(commits)
    if (!email) {
      try {
        // A creator may have commits elsewhere in the project but none in the
        // branch window we happened to fetch. Resolve the account project-wide;
        // GraphQL still verifies every commit SHA against the exact username
        // before its address can be used.
        const authored = await this.listProjectCommitsByAuthor(projectId, { username, accountId }, config)
        email = await findBoundEmail(authored)
      } catch (error) {
        lastLookupError = lastLookupError ?? error
      }
    }
    if (!email) {
      try {
        // GitLab's author filter is based on the commit identity string, which
        // may omit or lag an imported account. A bounded recent-history scan
        // gives GraphQL a second chance to bind a SHA to this exact account.
        const recent = await this.listRecentProjectCommits(projectId, config)
        email = await findBoundEmail(recent)
      } catch (error) {
        lastLookupError = lastLookupError ?? error
      }
    }
    if (email) {
      const value: ResolvedCreatorCommitEmail = {
        email,
        resolution: creatorStatus('verified-commit', false, 'commit identity exactly matches the verified creator account')
      }
      this.creatorCommitEmailCache.set(cacheKey, { value, expiresAt: Date.now() + PROFILE_SUCCESS_TTL_MS })
      return value
    }

    const status = errorStatus(lastLookupError)
    const lookupFailed = Boolean(lastLookupError)

    const noMatch: ResolvedCreatorCommitEmail = {
      email: '',
      resolution: creatorStatus(
        'account-email-hidden',
        lookupFailed && (status === undefined || isTransientStatus(status)),
        lookupFailed
          ? `account identity verified; commit identity lookup failed${status ? ` (${status})` : ''}`
          : 'account identity verified; no commit in the checked project history was bound to that account with a valid email'
      )
    }
    this.creatorCommitEmailCache.set(cacheKey, { value: noMatch, expiresAt: Date.now() + PROFILE_HIDDEN_TTL_MS })
    return noMatch
  }

  private async graphqlCommitIdentities(
    projectId: number,
    commitShas: string[],
    config?: GitLabConnectionConfig
  ): Promise<Map<string, CommitIdentity>> {
    const { url, token } = this.resolve(config)
    const fullPath = config?.projectPath || await this.projectPath(projectId, config)
    const graphqlUrl = `${apiBaseUrl(url, 'gitlab', config?.projectPath).replace(/\/api\/v4$/, '/api/graphql')}`
    const wanted = [...new Set(commitShas.map((sha) => String(sha).trim()).filter(Boolean))]
    const result = new Map<string, CommitIdentity>()
    for (let offset = 0; offset < wanted.length; offset += 25) {
      const batch = wanted.slice(offset, offset + 25)
      const fields = batch.map((sha, index) =>
        `c${index}: commit(ref: ${JSON.stringify(sha)}) { sha author { id username } committer { id username } }`
      ).join('\n')
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'PRIVATE-TOKEN': token,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: `query CreatorCommitIdentity($fullPath: ID!) {
            project(fullPath: $fullPath) {
              repository {
                ${fields}
              }
            }
          }`,
          variables: { fullPath }
        })
      })
      if (!response.ok) {
        const detail = apiErrorDetail(await response.text().catch(() => ''))
        throw new GitLabApiErrorImpl(
          `Remote repository API ${response.status}${detail ? `: ${detail}` : ''}`,
          response.status,
          detail
        )
      }
      const payload = await response.json() as {
        data?: { project?: { repository?: Record<string, unknown> } }
        errors?: Array<{ message?: string }>
      }
      if (payload.errors?.length) {
        throw new GitLabApiErrorImpl(`GitLab GraphQL: ${payload.errors.map((error) => error.message ?? 'request failed').join('; ')}`, 500)
      }
      const repository = payload.data?.project?.repository ?? {}
      const nodes = batch
        .map((_, index) => repository[`c${index}`])
        .filter((node): node is Record<string, unknown> => Boolean(node && typeof node === 'object'))
      for (const node of nodes) {
        const sha = String(node.sha ?? '').trim()
        if (!wanted.includes(sha)) continue
        const author = (node.author ?? {}) as Record<string, unknown>
        const committer = (node.committer ?? {}) as Record<string, unknown>
        result.set(sha, {
          author: String(author.username ?? '').trim() || undefined,
          committer: String(committer.username ?? '').trim() || undefined,
          authorId: forgeUserId(author.id) || undefined,
          committerId: forgeUserId(committer.id) || undefined
        })
      }
    }
    return result
  }

  private async listProjectCommitsByAuthor(
    projectId: number,
    identity: { username: string; accountId: string },
    config?: GitLabConnectionConfig
  ): Promise<GitLabCommitDto[]> {
    const projectRef = await this.projectRef(projectId, config)
    let accountError: unknown
    if (identity.accountId) {
      try {
        const byId = await this.listProjectCommitPages(projectRef, { author_id: identity.accountId }, config, 100)
        if (byId.length > 0) return byId
      } catch (error) {
        accountError = error
      }
    }
    if (identity.username) {
      return this.listProjectCommitPages(projectRef, { author: identity.username }, config, 100)
    }
    if (accountError) throw accountError
    return []
  }

  private async listRecentProjectCommits(
    projectId: number,
    config?: GitLabConnectionConfig
  ): Promise<GitLabCommitDto[]> {
    const projectRef = await this.projectRef(projectId, config)
    return this.listProjectCommitPages(projectRef, {}, config)
  }

  private async listProjectCommitPages(
    projectRef: string,
    filters: Record<string, string>,
    config?: GitLabConnectionConfig,
    maxPages = 3
  ): Promise<GitLabCommitDto[]> {
    const commits: GitLabCommitDto[] = []
    for (let page = 1; page <= maxPages; page += 1) {
      const qs = new URLSearchParams({ ...filters, per_page: '100', page: String(page) })
      const rows = await this.request<GitLabCommitDto[]>(
        `/projects/${projectRef}/repository/commits?${qs.toString()}`,
        config
      )
      commits.push(...rows)
      if (rows.length < 100) break
    }
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
  ): Promise<BranchCreatorLookupResult> {
    const creators = new Map<string, BranchCreatorDto>()
    const { provider } = this.resolve(config)
    const projectRef = await this.projectRef(projectId, config)
    if (provider === 'github') {
      let events: Array<Record<string, unknown>> = []
      let eventError: unknown
      try {
        events = await this.paginate(`/repos/${projectRef}/events?per_page=100`, config)
      } catch (error) {
        eventError = error
      }
      for (const event of events) {
        if (event.type !== 'PushEvent') continue
        const payload = (event.payload ?? {}) as Record<string, unknown>
        const ref = String(payload.ref ?? '')
        if (!ref.startsWith('refs/heads/') || !/^0+$/.test(String(payload.before ?? ''))) continue
        const branch = ref.slice('refs/heads/'.length)
        const actor = (event.actor ?? {}) as Record<string, unknown>
        const username = String(actor.login ?? '').trim()
        const name = String(actor.name ?? '').trim() || username
        if (!branch || !name || creators.has(branch)) continue
        creators.set(branch, {
          name,
          email: '',
          username,
          accountId: undefined,
          createdAt: typeof event.created_at === 'string' ? event.created_at : null,
          source: 'event',
          emailSource: '',
          emailResolution: username
            ? creatorStatus('account-lookup-failed', true, 'GitHub account profile pending')
            : creatorStatus('identity-missing', false, 'GitHub event did not include an actor login')
        })
      }
      await this.applyResolvedAccounts(creators, config)
      return creatorLookup(creators, eventError
        ? {
            status: 'unavailable',
            retryable: true,
            checkedAt: new Date().toISOString(),
            detail: errorStatus(eventError) ? `events returned ${errorStatus(eventError)}` : 'events request failed'
          }
        : { status: 'available', retryable: false, checkedAt: new Date().toISOString() })
    }
    if (provider !== 'gitlab') {
      return creatorLookup(creators, {
          status: 'unavailable',
          retryable: false,
          checkedAt: new Date().toISOString(),
          detail: `${provider} has no supported branch creation event stream`
      })
    }
    // Newest first. Events only cover a bounded window, so older branches may
    // simply not appear. Some self-hosted GitLab versions ignore `action` or
    // expose the author fields in a slightly different shape; query both forms
    // so a partially filtered result cannot hide creation events for other refs.
    const eventPages = async (withAction: boolean): Promise<Array<Record<string, unknown>>> => {
      const collected: Array<Record<string, unknown>> = []
      for (let page = 1; page <= 20; page += 1) {
        const qs = new URLSearchParams()
        if (withAction) qs.set('action', 'pushed')
        qs.set('per_page', '100')
        qs.set('page', String(page))
        const rows = await this.request<Array<Record<string, unknown>>>(`/projects/${projectRef}/events?${qs.toString()}`, config)
        if (!Array.isArray(rows) || rows.length === 0) break
        collected.push(...rows)
        if (rows.length < 100) break
      }
      return collected
    }

    let rows: Array<Record<string, unknown>> = []
    let filteredError: unknown
    let unfilteredError: unknown
    let filteredAvailable = false
    let unfilteredAvailable = false
    try {
      rows = await eventPages(true)
      filteredAvailable = true
    } catch (error) {
      filteredError = error
      logger.warn(`Could not read filtered branch creation events for project ${projectRef}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const parseEvents = (events: Array<Record<string, unknown>>): void => {
      for (const row of events) {
        const push = (row.push_data ?? {}) as Record<string, unknown>
        const action = String(push.action ?? row.action ?? '').toLowerCase()
        const refType = String(push.ref_type ?? row.ref_type ?? row.target_type ?? '').toLowerCase()
        const actionName = String(row.action_name ?? '').toLowerCase()
        const isCreation = action === 'created' || actionName === 'pushed new'
        if (!isCreation || refType !== 'branch') continue
        const rawRef = String(push.ref ?? row.ref ?? row.target_title ?? '').trim()
        const branch = rawRef.replace(/^refs\/heads\//, '')
        if (!branch || creators.has(branch)) continue
        const author = (row.author ?? {}) as Record<string, unknown>
        const username = String(author.username ?? row.author_username ?? '').trim()
        const authorId = Number(author.id ?? row.author_id ?? NaN)
        const name = String(author.name ?? '').trim()
          || String(row.author_name ?? '').trim()
          || username
          || (author.id ?? row.author_id ? `GitLab user ${String(author.id ?? row.author_id)}` : '')
        if (!name) continue
        creators.set(branch, {
          name,
          email: String(author.public_email ?? '').trim(),
          username,
          userId: Number.isFinite(authorId) ? authorId : null,
          accountId: Number.isFinite(authorId) ? String(authorId) : undefined,
          createdAt: typeof row.created_at === 'string' ? row.created_at : null,
          source: 'event',
          emailSource: String(author.public_email ?? '').trim() ? 'account' : '',
          emailResolution: String(author.public_email ?? '').trim()
            ? creatorStatus('verified-account', false, 'public_email from branch creation event')
            : username || Number.isFinite(authorId)
              ? creatorStatus('account-lookup-failed', true, 'GitLab account profile pending')
              : creatorStatus('identity-missing', false, 'GitLab creation event did not include an account identity')
        })
      }
    }
    parseEvents(rows)
    try {
      parseEvents(await eventPages(false))
      unfilteredAvailable = true
    } catch (error) {
      unfilteredError = error
      logger.warn(`Could not read unfiltered branch creation events for project ${projectRef}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.applyResolvedAccounts(creators, config)
    const eventError = filteredError ?? unfilteredError
    const status = filteredAvailable && unfilteredAvailable
      ? 'available'
      : filteredAvailable || unfilteredAvailable
        ? 'partial'
        : 'unavailable'
    return creatorLookup(creators, {
        status,
        retryable: Boolean(eventError),
        checkedAt: new Date().toISOString(),
        ...(eventError
          ? { detail: errorStatus(eventError) ? `creation events returned ${errorStatus(eventError)}` : 'creation events request failed' }
          : {})
    })
  }

  private async applyResolvedAccounts(
    creators: Map<string, BranchCreatorDto>,
    config?: GitLabConnectionConfig
  ): Promise<void> {
    const entries = [...new Map(
      [...creators.values()]
        .filter((creator) => creator.username || creator.accountId || creator.userId)
        .map((creator) => [
          creator.accountId || creator.username.toLowerCase(),
          { username: creator.username, accountId: creator.accountId || (creator.userId ? String(creator.userId) : undefined) }
        ])
    ).values()]
    const resolved = await this.resolveAccountIdentities(entries, config)
    for (const creator of creators.values()) {
      // A public address on the creation event is already bound to the actor.
      if (creator.emailSource === 'account' && creator.email) continue
      const key = creator.accountId || creator.username.toLowerCase()
      const account = resolved.get(key)
      if (!account) continue
      if (account.name && account.name !== account.username) creator.name = account.name || creator.name
      creator.username = account.username || creator.username
      creator.accountId = account.accountId || creator.accountId
      creator.userId = account.accountId && /^\d+$/.test(account.accountId)
        ? Number(account.accountId)
        : creator.userId
      creator.email = account.email
      creator.emailSource = account.source
      creator.emailResolution = account.resolution
    }
  }

  /**
   * Resolve an exact forge account. GitLab is queried by stable id first and
   * then by exact username; GitHub is queried by exact login. Display-name
   * search results and account-id mismatches are never accepted.
   */
  async resolveAccountIdentity(
    identity: { username?: string; accountId?: string | null },
    config?: GitLabConnectionConfig
  ): Promise<ResolvedForgeUser> {
    const username = String(identity.username ?? '').trim()
    const accountId = String(identity.accountId ?? '').trim()
    const checkedAt = new Date().toISOString()
    if (!username && !accountId) {
      return {
        name: username || (accountId ? `Account ${accountId}` : ''),
        username,
        accountId,
        email: '',
        source: '',
        resolution: creatorStatus('identity-missing', false, 'creation event has no account id or username')
      }
    }
    const { provider } = this.resolve(config)
    const cacheKey = this.userProfileKey({ username, accountId }, config)
    const cached = this.userProfileCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    if (cached) this.userProfileCache.delete(cacheKey)

    let lastError: unknown
    let identityMismatch = false
    if (provider === 'github') {
      if (!username) {
        return {
          name: username,
          username,
          accountId,
          email: '',
          source: '',
          resolution: creatorStatus('identity-missing', false, 'GitHub lookup requires a login')
        }
      }
      try {
        const profile = await this.request<Record<string, unknown>>(`/users/${encodeURIComponent(username)}`, config)
        const login = String(profile.login ?? '').trim()
        if (login.toLowerCase() !== username.toLowerCase()) {
          return {
            name: String(profile.name ?? '').trim() || username,
            username,
            accountId,
            email: '',
            source: '',
            resolution: creatorStatus('identity-mismatch', false, 'GitHub profile login does not match the event actor')
          }
        }
        return this.completeAccountResolution(profile, { username, accountId, checkedAt }, cacheKey)
      } catch (error) {
        return {
          name: username,
          username,
          accountId,
          email: '',
          source: '',
          resolution: accountLookupFailure(error)
        }
      }
    }
    if (provider !== 'gitlab') {
      return {
        name: username,
        username,
        accountId,
        email: '',
        source: '',
        resolution: creatorStatus('account-lookup-failed', true, `${provider} creator account resolution is not implemented`)
      }
    }

    let profile: Record<string, unknown> | undefined
    if (accountId && /^\d+$/.test(accountId)) {
      try {
        const byId = await this.request<Record<string, unknown>>(`/users/${encodeURIComponent(accountId)}`, config)
        if (String(byId.id ?? '').trim() === accountId) {
          profile = byId
        } else {
          identityMismatch = true
        }
      } catch (error) {
        lastError = error
      }
    }
    if (!profile && username) {
      try {
        const qs = new URLSearchParams({ username })
        const rows = await this.request<Array<Record<string, unknown>>>(`/users?${qs.toString()}`, config)
        const exact = Array.isArray(rows)
          ? rows.find((row) => String(row.username ?? '').trim().toLowerCase() === username.toLowerCase())
          : undefined
        if (exact) {
          const responseId = String(exact.id ?? '').trim()
          if (accountId && (!responseId || responseId !== accountId)) {
            identityMismatch = true
          } else {
            profile = exact
          }
        }
      } catch (error) {
        lastError = error
      }
    }
    if (profile) return this.completeAccountResolution(profile, { username, accountId, checkedAt, config }, cacheKey)
    if (identityMismatch) {
      return {
        name: username || `Account ${accountId}`,
        username,
        accountId,
        email: '',
        source: '',
        resolution: creatorStatus('identity-mismatch', false, 'forge account response does not match the creation identity')
      }
    }
    if (lastError) {
      return {
        name: username || `Account ${accountId}`,
        username,
        accountId,
        email: '',
        source: '',
        resolution: accountLookupFailure(lastError)
      }
    }
    const notFound: ResolvedForgeUser = {
      name: username || `Account ${accountId}`,
      username,
      accountId,
      email: '',
      source: '',
      resolution: creatorStatus('account-not-found', false, 'no exact forge account matched the creation identity')
    }
    this.userProfileCache.set(cacheKey, {
      value: notFound,
      expiresAt: Date.now() + PROFILE_HIDDEN_TTL_MS
    })
    return notFound
  }

  private async completeAccountResolution(
    profile: Record<string, unknown>,
    identity: { username: string; accountId: string; checkedAt: string; config?: GitLabConnectionConfig },
    cacheKey: string
  ): Promise<ResolvedForgeUser> {
    const profileUsername = String(profile.username ?? profile.login ?? '').trim()
    const profileId = String(profile.id ?? '').trim()
    if (identity.accountId && profileId !== identity.accountId) {
      return {
        name: identity.username || `Account ${identity.accountId}`,
        username: identity.username,
        accountId: identity.accountId,
        email: '',
        source: '',
        resolution: creatorStatus('identity-mismatch', false, 'forge account id does not match the creation event')
      }
    }
    if (!profileUsername || (identity.username && profileUsername.toLowerCase() !== identity.username.toLowerCase())) {
      return {
        name: identity.username || `Account ${identity.accountId}`,
        username: identity.username,
        accountId: identity.accountId || profileId,
        email: '',
        source: '',
        resolution: creatorStatus('identity-mismatch', false, 'forge account username does not match the creation event')
      }
    }
    const email = [
      profile.public_email,
      profile.email,
      profile.commit_email
    ].map((value) => String(value ?? '').trim()).find((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) ?? ''
    const result: ResolvedForgeUser = {
      name: String(profile.name ?? profile.display_name ?? '').trim() || identity.username || profileUsername,
      username: profileUsername || identity.username,
      accountId: profileId || identity.accountId,
      email,
      source: email ? 'account' : '',
      resolution: email
        ? creatorStatus('verified-account', false, 'exact forge account profile')
        : creatorStatus('account-email-hidden', false, 'exact forge account profile did not expose an email')
    }
    if (email) {
      this.userProfileCache.set(cacheKey, {
        value: result,
        expiresAt: Date.now() + PROFILE_SUCCESS_TTL_MS
      })
      return result
    }
    // The account is already proven; an admin token can still read the
    // private email list even when the profile hides it.
    const adminEmail = await this.adminEmailForAccount(identity.accountId, identity.config)
    if (adminEmail) {
      result.email = adminEmail
      result.source = 'account'
      result.resolution = creatorStatus('verified-account', false, 'exact forge account private email')
    }
    this.userProfileCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + (adminEmail ? PROFILE_SUCCESS_TTL_MS : PROFILE_HIDDEN_TTL_MS)
    })
    return result
  }

  private async adminEmailForAccount(
    accountId: string,
    config?: GitLabConnectionConfig
  ): Promise<string> {
    if (!accountId || !/^\d+$/.test(accountId)) return ''
    try {
      const rows = await this.request<Array<Record<string, unknown>>>(
        `/users/${encodeURIComponent(accountId)}/emails`,
        config,
        {},
        { timeoutMs: REQUEST_TIMEOUT_MS, retries: 0 }
      )
      if (!Array.isArray(rows)) return ''
      const active = rows.find((row) => Boolean(row.confirm_status ?? true))
      return String(active?.email ?? '').trim()
    } catch {
      return ''
    }
  }

  async resolveAccountIdentities(
    identities: Array<{ username?: string; accountId?: string | null }>,
    config?: GitLabConnectionConfig
  ): Promise<Map<string, ResolvedForgeUser>> {
    const unique = new Map<string, { username?: string; accountId?: string | null }>()
    for (const identity of identities) {
      const username = String(identity.username ?? '').trim()
      const accountId = String(identity.accountId ?? '').trim()
      if (!username && !accountId) continue
      unique.set(accountId || username.toLowerCase(), { username, accountId })
    }
    const entries = [...unique.entries()]
    const resolvedEntries = await mapWithConcurrency(
      entries,
      PROFILE_LOOKUP_CONCURRENCY,
      async ([, identity]) => [identity.accountId || String(identity.username).toLowerCase(), await this.resolveAccountIdentity(identity, config)] as const
    )
    return new Map(resolvedEntries)
  }

  /**
   * Resolve the public address of forge accounts by exact username.
   *
   * GitLab hides `public_email` on commit and event payloads whenever the user
   * did not opt in, but the user directory still reports it (and, on instances
   * that expose it, the account `email`). Without this lookup a branch created
   * from the web UI that carries no commit has a correct creator name and no
   * way to reach them.
   *
   * The username must match exactly. Falling back to the first search result
   * would attach a same-named stranger's address to the branch creator.
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
    const accounts = await this.resolveAccountIdentities(
      [...new Set(usernames.map((name) => name.trim()).filter(Boolean))].map((username) => ({ username })),
      config
    )
    for (const account of accounts.values()) {
      if (account.source === 'account' && account.email) {
        resolved.set(account.username.toLowerCase(), account.email)
      }
    }
    return resolved
  }

  async getProject(projectId: number, config?: GitLabConnectionConfig): Promise<GitLabProject> {
    const { url, provider } = this.resolve(config)
    if (provider === 'github') return this.normalizeProject(await this.request<Record<string, unknown>>(`/repositories/${projectId}`, config), provider)
    if (provider === 'gitee') return this.normalizeProject(await this.request<Record<string, unknown>>(`/repos/${projectId}`, config), provider)
    // Always address GitLab projects by numeric id. Encoded project paths are
    // accepted by GitLab itself, but some intranet reverse proxies reject the
    // `%2F` with a 500. The cached path is only metadata and must not decide
    // which URL is requested here.
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

