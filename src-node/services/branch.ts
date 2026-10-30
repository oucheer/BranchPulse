import type {
  BranchCriteria,
  BranchState,
  BranchSummary,
  CommitInfo,
  CreatorInfo,
  CreatorEmailResolution,
  HealthResult,
  MonitoringConfig,
  NamingResult,
  ProtectionInfo,
  Repository,
  ThresholdRule,
} from '@shared/types'
import type { GitLabConnectionConfig } from '@shared/types'
import type { GitRefInfo, GitService } from './git'
import type { RepositoryService } from './repository'
import type { NamingService } from './naming'
import type { ProtectionService } from './protection'
import type { HealthService } from './health'
import type { StorageService } from './storage'
import type { AuditService } from './audit'
import type { SettingsService } from './settings'
import type { BranchCreatorDto, BranchCreatorEventState, GitLabBranchDto, GitLabCommitDto, GitLabService } from './gitlab'
import { newId } from '../utils/ids'

const DAY_MS = 24 * 60 * 60 * 1000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Keep a creator name, but retain an address only when it is attached to the
 * forge account. Legacy snapshots and commit signatures do not carry that
 * proof and must not become notification targets by accident.
 */
function verifiedResolution(
  source: CreatorInfo['emailSource'],
  checkedAt = new Date().toISOString()
): CreatorEmailResolution | undefined {
  if (source !== 'account' && source !== 'commit') return undefined
  return {
    status: source === 'account' ? 'verified-account' : 'verified-commit',
    retryable: false,
    checkedAt
  }
}

function hasVerifiedCreatorEmail(creator: CreatorInfo): boolean {
  if (!EMAIL_PATTERN.test(String(creator.email ?? '').trim())) return false
  if (creator.emailSource === 'account') return creator.emailResolution?.status === 'verified-account'
  if (creator.emailSource === 'commit') return creator.emailResolution?.status === 'verified-commit'
  return false
}

function creatorEmailMatchesSource(creator: CreatorInfo, email: string): boolean {
  return hasVerifiedCreatorEmail({ ...creator, email })
}

export function sanitizeCreatorInfo(creator: CreatorInfo): CreatorInfo {
  const name = String(creator.name ?? '').trim()
  const email = String(creator.email ?? '').trim()
  const emailSource: CreatorInfo['emailSource'] = creator.emailSource === 'account' || creator.emailSource === 'commit'
    ? creator.emailSource
    : ''
  const emailResolution = creator.emailResolution
    ? {
        status: creator.emailResolution.status,
        retryable: Boolean(creator.emailResolution.retryable),
        checkedAt: creator.emailResolution.checkedAt || new Date().toISOString(),
        ...(creator.emailResolution.detail ? { detail: creator.emailResolution.detail } : {})
      }
    : {
        status: email || emailSource ? 'legacy-unverified' as const : 'legacy-unverified' as const,
        retryable: true,
        checkedAt: new Date().toISOString(),
        detail: 'creator record was saved without email resolution evidence'
      }
  if (emailSource && creatorEmailMatchesSource({ ...creator, emailSource, emailResolution }, email)) {
    return { ...creator, name, email, emailSource, emailResolution, confidence: 'high' }
  }
  return {
    ...creator,
    name,
    email: '',
    emailSource: '',
    emailResolution,
    confidence: !name || name === 'Unknown' ? 'unknown' : 'medium'
  }
}

/**
 * Decide who created a remote branch.
 *
 * A commit author is not proof of who created a ref. Remote branch creation
 * must come from the forge's ref-creation event; when that event is absent the
 * creator stays unknown and the tip commit author is kept separately.
 *
 * Exported for unit tests; the attribution rules are easy to regress and hard to
 * observe end to end.
 */
export function resolveRemoteCreator(
  _firstOwnCommit: GitLabCommitDto | null,
  creationEvent: BranchCreatorDto | null,
  _branchTip: GitLabCommitDto | null = null
): { creator: CreatorInfo } {
  if (creationEvent) {
    return {
      creator: sanitizeCreatorInfo({
        name: creationEvent.name,
        email: creationEvent.email,
        emailSource: creationEvent.emailSource,
        username: creationEvent.username,
        accountId: creationEvent.accountId || (creationEvent.userId ? String(creationEvent.userId) : undefined),
        emailResolution: creationEvent.emailResolution ?? {
          status: creationEvent.email ? 'legacy-unverified' : 'creation-event-missing',
          retryable: Boolean(creationEvent.username || creationEvent.userId),
          checkedAt: new Date().toISOString()
        },
        firstCommitAt: creationEvent.createdAt,
        confidence: creationEvent.email ? 'high' : 'medium'
      })
    }
  }
  return {
    creator: {
      name: 'Unknown',
      email: '',
      emailSource: '',
      emailResolution: {
        status: 'creation-event-missing',
        retryable: true,
        checkedAt: new Date().toISOString()
      },
      firstCommitAt: null,
      confidence: 'unknown'
    }
  }
}

/**
 * Cached snapshots may contain addresses written before provenance existed.
 * Clear them instead of reconstructing an address from a same-named author.
 */
export function backfillCachedCreatorEmail(cached: BranchSummary): BranchSummary {
  return { ...cached, creator: sanitizeCreatorInfo(cached.creator) }
}

/**
 * Accept a commit email as creator provenance only when the forge resolved
 * that commit to the same account that created the branch. GitHub/Gitee return
 * the account login on commits, so an exact login match proves the email
 * belongs to the creator account; a display-name match would not.
 */
export function creatorEmailFromCommits(
  creationEvent: BranchCreatorDto | null,
  commits: GitLabCommitDto[]
): { email: string; source: 'commit' | '' } {
  const username = creationEvent?.username?.trim().toLowerCase()
  if (!username) return { email: '', source: '' }
  const candidates = [...commits]
    .filter((commit) =>
      String(commit.author_login ?? '').trim().toLowerCase() === username
      || String(commit.committer_login ?? '').trim().toLowerCase() === username
    )
    .sort((a, b) => {
      const aTime = new Date(a.committed_date || a.authored_date || a.created_at || 0).getTime()
      const bTime = new Date(b.committed_date || b.authored_date || b.created_at || 0).getTime()
      return aTime - bTime
    })
  for (const commit of candidates) {
    const authorLogin = String(commit.author_login ?? '').trim().toLowerCase()
    const committerLogin = String(commit.committer_login ?? '').trim().toLowerCase()
    const authorEmail = String(commit.author_email ?? '').trim()
    const committerEmail = String(commit.committer_email ?? '').trim()
    if (authorLogin === username && EMAIL_PATTERN.test(authorEmail)) {
      return { email: authorEmail, source: 'commit' }
    }
    if (committerLogin === username && EMAIL_PATTERN.test(committerEmail)) {
      return { email: committerEmail, source: 'commit' }
    }
  }
  return { email: '', source: '' }
}

/**
 * GitHub/Gitee commits expose the author email directly. Accept it only when
 * the commit's forge login matches the branch-creation account, so the address
 * is still bound to the same account that created the branch.
 */
export function emailFromMatchingCommit(
  username: string,
  commits: GitLabCommitDto[]
): { email: string; source: 'commit' | '' } {
  const needle = username.trim().toLowerCase()
  if (!needle) return { email: '', source: '' }
  const match = [...commits].find((commit) =>
    String(commit.author_login ?? '').trim().toLowerCase() === needle
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(commit.author_email ?? '').trim())
  )
  return match ? { email: String(match.author_email).trim(), source: 'commit' } : { email: '', source: '' }
}

const normalizeIdentity = (value: string | null | undefined): string => String(value ?? '').trim().toLowerCase()

/** Accept a creator address only from an exact forge-account lookup. */
export function creatorEmailFromIdentityChain(
  creator: CreatorInfo,
  creationEvent: BranchCreatorDto | null,
  _firstOwn: GitLabCommitDto | null,
  emailsByUsername: Map<string, string>
): { email: string; source: 'account' | 'commit' | ''; resolution?: CreatorEmailResolution } {
  if (creator.emailSource === 'account' && hasVerifiedCreatorEmail(creator)) {
    return { email: creator.email, source: 'account', resolution: creator.emailResolution }
  }
  const username = normalizeIdentity(creationEvent?.username || creator.username)
  const profileEmail = username ? emailsByUsername.get(username) ?? emailsByUsername.get(username.toLowerCase()) : undefined
  if (profileEmail && EMAIL_PATTERN.test(profileEmail)) {
    return {
      email: profileEmail,
      source: 'account',
      resolution: {
        status: 'verified-account',
        retryable: false,
        checkedAt: new Date().toISOString()
      }
    }
  }
  return { email: '', source: '' }
}

interface AnalysisFacts {
  name: string
  type: 'local' | 'remote'
  remote?: string
  existsLocally: boolean
  existsRemotely: boolean
  isHead: boolean
  creator: BranchSummary['creator']
  createdAt: string | null
  lastCommitAt: string | null
  lastCommitSha: string
  lastAuthor: string
  lastAuthorEmail?: string
  commitCount: number
  ahead: number
  behind: number
  merged: boolean
  mergedInto: string | null
  baseBranch: string
  recentCommits: CommitInfo[]
}

function remoteBranchConfig(repo: Repository, apiKey?: string): GitLabConnectionConfig {
  if (repo.source === 'github' || repo.source === 'gitee' || repo.source === 'gitlab') {
    return { provider: repo.source, url: repo.gitlabUrl ?? '', projectPath: repo.remoteProjectPath, ...(apiKey ? { apiKey } : {}) }
  }
  return { provider: 'gitlab' }
}

function normRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}

function refForLocal(repoPath: string, name: string): string {
  return `refs/heads/${name}`
}

function refForRemote(remote: string, name: string): string {
  return `refs/remotes/${remote}/${name}`
}

function emailForUsername(emails: Map<string, string>, username?: string): string | undefined {
  if (!username) return undefined
  return emails.get(username) ?? emails.get(username.toLowerCase())
}

function safeTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function elapsedDays(timestamp: string | null | undefined, now = Date.now()): number {
  const parsed = safeTimestamp(timestamp)
  if (!Number.isFinite(parsed)) return 0
  return Math.floor(Math.max(0, now - parsed) / DAY_MS)
}
function elapsedHours(timestamp: string | null | undefined, now = Date.now()): number {
  const parsed = safeTimestamp(timestamp)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, (now - parsed) / (60 * 60 * 1000))
}
function fingerprint(monitoring: MonitoringConfig, naming: NamingService, protection: ProtectionService, repositoryId?: string | null): string {
  const rules = naming
    .listRules(repositoryId)
    .map((r) => `${r.id}:${r.enabled}:${r.mode}:${r.type}:${r.pattern}`)
    .join('|')
  const wl = protection.listWhitelist(repositoryId).map((e) => `${e.type}:${e.pattern}`).join('|')
  const pr = protection.listProtected(repositoryId).map((e) => `${e.type}:${e.pattern}`).join('|')
  const thresholds = thresholdRuleFingerprint(monitoring)
  return `${monitoring.staleThresholdUnit}|${monitoring.staleThresholdDays}|${thresholds}|${rules}|${wl}|${pr}`
}

/** 存储里的前缀规则是 JSON 文本；坏数据降级为空数组而不是抛错。 */
export function parseThresholdRules(raw: unknown): ThresholdRule[] {
  if (Array.isArray(raw)) return normalizeThresholdRules(raw)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    return normalizeThresholdRules(JSON.parse(raw))
  } catch {
    return []
  }
}

function normalizeThresholdRules(input: unknown): ThresholdRule[] {
  if (!Array.isArray(input)) return []
  const rules: ThresholdRule[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const prefix = String(record.prefix ?? '').trim()
    const value = Number(record.value)
    const unit = String(record.unit ?? 'days') as ThresholdRule['unit']
    if (!prefix || !Number.isFinite(value) || value <= 0) continue
    if (![
      'minutes',
      'hours',
      'days',
      'weeks'
    ].includes(unit)) continue
    rules.push({ prefix, value, unit })
  }
  return rules
}

/** 存储格式唯一出口：写库时序列化，读库时用 parseThresholdRules() 解析。 */
export function serializeThresholdRules(rules: ThresholdRule[] | undefined): string {
  return JSON.stringify(normalizeThresholdRules(rules ?? []))
}

function thresholdRuleFingerprint(monitoring: MonitoringConfig): string {
  return (monitoring.thresholdRules ?? [])
    .map((rule) => `${rule.prefix}:${rule.unit}:${rule.value}`)
    .join(',')
}

function thresholdToHours(value: number, unit: MonitoringConfig['staleThresholdUnit']): number {
  if (unit === 'minutes') return value / 60
  if (unit === 'hours') return value
  if (unit === 'weeks') return value * 24 * 7
  return value * 24
}

/**
 * 分支实际生效的未提交阈值。
 *
 * 前缀规则里前缀最长（最具体）的那条优先，`release/` 与 `release/1.x/` 同时配置时后者胜出；
 * 未命中任何规则时回落到全局阈值。基准分支同样按此计算，但生命周期评比本身会豁免它们。
 */
export function effectiveThreshold(
  monitoring: MonitoringConfig,
  branchName: string
): { hours: number; value: number; unit: MonitoringConfig['staleThresholdUnit'] } {
  const rules = [...(monitoring.thresholdRules ?? [])].sort((a, b) => b.prefix.length - a.prefix.length)
  const match = rules.find((rule) => branchName.startsWith(rule.prefix))
  const value = match ? match.value : monitoring.staleThresholdDays
  const unit = match ? match.unit : monitoring.staleThresholdUnit
  return { hours: thresholdToHours(value, unit), value, unit }
}

/**
 * 基准分支（main / develop / 仓库默认分支）是所有分支的评分参照物，
 * 不参与生命周期评比：不计已停更、不进清理候选、不进需要关注的列表。
 */
export function isBaselineBranch(name: string, baseBranch?: string | null): boolean {
  if (/^(main|develop)$/i.test(name) || name === 'develop_XC') return true
  return Boolean(baseBranch) && name === baseBranch
}

/** main 和 develop 完全不进入检查、报告和邮件范围。 */
export function isMonitoredBranch(name: string): boolean {
  return !/^(main|develop)$/i.test(name) && name !== 'develop_XC'
}

export interface RepositoryScanOptions {
  fetch?: boolean
  force?: boolean
  progress?: (message: string) => void
}

export class BranchService {
  constructor(
    private readonly storage: StorageService,
    private readonly git: GitService,
    private readonly repositoryService: RepositoryService,
    private readonly gitlab: GitLabService,
    private readonly naming: NamingService,
    private readonly protection: ProtectionService,
    private readonly health: HealthService,
    private readonly audit: AuditService,
    private readonly settingsService: SettingsService
  ) {}

  private monitoring(repositoryId?: string | null): MonitoringConfig {
    const row = repositoryId
      ? (this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules_repo WHERE repository_id = ?', [repositoryId])
        ?? this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules WHERE id = 1'))
      : this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules WHERE id = 1')
    return {
      enabled: (row?.enabled ?? 1) === 1,
      staleThresholdDays: Number(row?.stale_threshold_days ?? 180),
      staleThresholdUnit: ((row?.stale_threshold_unit as MonitoringConfig['staleThresholdUnit']) ?? 'days'),
      thresholdRules: parseThresholdRules(row?.threshold_rules),
      fetchEnabled: (row?.fetch_enabled ?? 1) === 1,
      namingEnabled: (row?.naming_enabled ?? 1) === 1,
      emailPolicy: ((row?.email_policy as MonitoringConfig['emailPolicy']) ?? 'none') as MonitoringConfig['emailPolicy'],
      notificationEnabled: (row?.notification_enabled ?? 1) === 1,
      notifyTarget: ((row?.notify_target as MonitoringConfig['notifyTarget']) ?? 'self')
    }
  }

  async scanRepository(repositoryId: string, options: RepositoryScanOptions = {}): Promise<BranchSummary[]> {
    const repo = this.repositoryService.get(repositoryId)
    if (!repo) throw new Error('Repository not found.')
    if (repo.source === 'gitlab' || repo.source === 'github' || repo.source === 'gitee') {
      return this.scanGitLabRepository(repo, options)
    }
    throw new Error('GitManager 现在只通过远程仓库 API 扫描，请添加远程仓库。')
  }

  private async scanGitLabRepository(repo: Repository, options: RepositoryScanOptions = {}): Promise<BranchSummary[]> {
    const progress = options.progress ?? ((): void => undefined)
    const monitoring = this.monitoring(repo.id)
    const fp = fingerprint(monitoring, this.naming, this.protection, repo.id)
    const projectId = repo.gitlabProjectId
    if (!projectId) throw new Error('GitLab project id is missing for this repository.')

    progress('Fetching GitLab branches...')
    const remoteConfig = remoteBranchConfig(repo, this.repositoryService.getRemoteToken(repo.id) || this.settingsService.getGitLabToken())
    const branches = await this.gitlab.listBranches(projectId, remoteConfig)
    const defaultBranch = repo.defaultBranch || branches.find((b) => b.default)?.name || 'main'
    progress(`Analyzing ${branches.length} GitLab branches...`)
    // Branch creation is not derivable from commits, so ask the forge who
    // created each branch. Empty for providers without that event stream.
    const creatorLookup = await this.gitlab.listBranchCreators(projectId, remoteConfig)
    const branchCreators = creatorLookup.creators
    const analyzed: BranchSummary[] = []
    const failedBranches: Array<{ name: string; reason: string }> = []
    const batchSize = 6
    for (let i = 0; i < branches.length; i += batchSize) {
      const batch = branches.slice(i, i + batchSize)
      // One flaky branch (a proxy hiccup, a 429, a slow compare) must never turn
      // the whole repository into "0 branches": settle every branch in the batch
      // and keep the ones that succeeded. A partial result is then refused below
      // so stale/complete cache data is never replaced by an incomplete snapshot.
      const results = await Promise.allSettled(
        batch.map((branch) => this.analyzeGitLabBranch(
          repo,
          projectId,
          branch,
          defaultBranch,
          branchCreators,
          creatorLookup.events,
          monitoring,
          fp,
          remoteConfig
        ))
      )
      results.forEach((entry, index) => {
        if (entry.status === 'fulfilled') {
          analyzed.push(entry.value)
          return
        }
        const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
        failedBranches.push({ name: batch[index].name, reason })
      })
      progress(`Analyzed ${Math.min(i + batchSize, branches.length)} of ${branches.length} branches...`)
    }
    if (failedBranches.length > 0) {
      const sample = failedBranches.slice(0, 3).map((item) => `${item.name}（${item.reason}）`).join('；')
      progress(`${failedBranches.length} 个分支分析失败，已跳过：${sample}`)
      // A partial branch set is not a trustworthy repository snapshot. Do not
      // replace the cached complete result or let monitoring/reporting publish
      // a branch total that depends on which operation happened to run first.
      const failureLabel = analyzed.length === 0 ? '全部分析失败' : `${failedBranches.length} 个分支分析失败`
      throw new Error(`${failureLabel}：${sample}`)
    }

    this.storage.transaction(() => {
      // A complete remote listing is authoritative. Remove cached branches that
      // were deleted remotely so report totals match the latest check.
      this.storage.delete('branches', 'repository_id = ?', [repo.id])
      this.storage.delete('branch_snapshots', 'key LIKE ?', [`${repo.id}|%`])
      for (const branch of analyzed) {
        const key = `${repo.id}|${branch.type}|${branch.name}`
        this.storage.delete('branches', 'key = ?', [key])
        this.storage.insert('branches', {
          id: newId(),
          key,
          repository_id: repo.id,
          name: branch.name,
          type: branch.type,
          data_json: JSON.stringify(branch),
          last_scanned_at: new Date().toISOString()
        })
        this.storage.update('branch_snapshots', { sha: branch.lastCommitSha, updated_at: new Date().toISOString() }, 'key = ?', [key])
        if (this.storage.get('SELECT 1 AS x FROM branch_snapshots WHERE key = ?', [key]) === undefined) {
          this.storage.insert('branch_snapshots', { key, sha: branch.lastCommitSha, updated_at: new Date().toISOString() })
        }
      }
    })

    this.repositoryService.update(repo.id, {
      currentBranch: defaultBranch,
      defaultBranch,
      totalBranches: analyzed.length,
      lastFetchAt: new Date().toISOString(),
      lastScanAt: new Date().toISOString()
    })
    this.audit.record('repository_scanned', {
      repository: repo.name,
      source: repo.source,
      branches: analyzed.length,
      stale: analyzed.filter((b) => b.stale).length,
      namingInvalid: analyzed.filter((b) => b.naming.status === 'invalid').length,
      merged: analyzed.filter((b) => b.merged).length
    })
    const resolutionCounts: Record<string, number> = {}
    for (const branch of analyzed) {
      const status = branch.creator.emailResolution?.status ?? 'legacy-unverified'
      resolutionCounts[status] = (resolutionCounts[status] ?? 0) + 1
    }
    this.audit.record('creator_email_resolution', {
      repository: repo.name,
      events: creatorLookup.events.status,
      eventsRetryable: creatorLookup.events.retryable,
      counts: resolutionCounts,
      retryable: analyzed.filter((branch) => branch.creator.emailResolution?.retryable).length,
      samples: analyzed
        .filter((branch) => !hasVerifiedCreatorEmail(branch.creator))
        .slice(0, 5)
        .map((branch) => ({
          branch: branch.name,
          username: branch.creator.username || undefined,
          status: branch.creator.emailResolution?.status ?? 'legacy-unverified',
          reason: branch.creator.emailResolution?.detail || undefined
        }))
    })
    return analyzed
  }

  private async analyzeGitLabBranch(
    repo: Repository,
    projectId: number,
    branch: GitLabBranchDto,
    defaultBranch: string,
    branchCreators: Map<string, BranchCreatorDto>,
    eventState: BranchCreatorEventState,
    monitoring: MonitoringConfig,
    fp: string,
    config?: GitLabConnectionConfig
  ): Promise<BranchSummary> {
    const cacheKey = `${repo.id}|remote|${branch.name}`
    const commits = await this.gitlab.listCommits(projectId, branch.name, 1, 100, config)
    // Prefer commits[0] over branch.commit: GitHub /branches does NOT return full commit objects (no dates/authors).
    const commitHasDate = (c: { committed_date?: string; authored_date?: string; created_at?: string } | undefined): boolean => Boolean(c && (c.committed_date || c.authored_date || c.created_at))
    const latestCommit: GitLabCommitDto | undefined = commitHasDate(commits[0])
      ? commits[0]
      : commitHasDate(branch.commit)
        ? branch.commit
        : commits[0] ?? branch.commit
    // v12: invalidate caches saved by the web build before creator email lookup
    // keys matched pantum-exe, so a deployed database cannot keep old creators.
    const creatorKey = creatorKeyForCache(branchCreators.get(branch.name))
    // v20 separates hidden account emails from forbidden, rate-limited and
    // transient private-email lookups. Re-analyse cached rows once so an old
    // account-email-hidden status cannot mask a retryable or permission issue.
    const cacheContentKey = `v20|${latestCommit?.id ?? ''}|${creatorKey}|${fp}`
    const existing = this.storage.get<Record<string, unknown>>('SELECT data_json FROM branches WHERE key = ?', [cacheKey])
    const snapshot = this.storage.get<Record<string, unknown>>('SELECT sha FROM branch_snapshots WHERE key = ?', [cacheKey])
    if (snapshot?.sha === cacheContentKey && existing?.data_json) {
      try {
        const cached = JSON.parse(String(existing.data_json)) as BranchSummary
        const creator = backfillCachedCreatorEmail(cached).creator
        const resolution = creator.emailResolution
        const canReuse = hasVerifiedCreatorEmail(creator) && resolution?.retryable !== true
        if (canReuse && (cached.lastAuthorEmail || cached.lastAuthor)) {
          return this.refreshComputed({ ...cached, creator }, monitoring, { name: branch.name } as GitRefInfo, '')
        }
      } catch {
        /* fall through */
      }
    }

    const recentCommits = [...commits]
    if (commits.length === 100) {
      const oldestDate = commits[commits.length - 1]?.committed_date ?? commits[commits.length - 1]?.authored_date ?? commits[commits.length - 1]?.created_at
      const cutoff = Date.now() - 8 * DAY_MS
      if (oldestDate && new Date(oldestDate).getTime() > cutoff) {
        for (let page = 2; page <= 5; page += 1) {
          const more = await this.gitlab.listCommits(projectId, branch.name, page, 100, config)
          if (!more.length) break
          recentCommits.push(...more)
          if (more.length < 100) break
          const lastDate = more[more.length - 1]?.committed_date ?? more[more.length - 1]?.authored_date ?? more[more.length - 1]?.created_at
          if (!lastDate || new Date(lastDate).getTime() <= cutoff) break
        }
      }
    }

    // Commits this branch has and the default branch does not. Index 0 is the
    // branch's first own commit, which is what identifies who started it.
    //
    // This replaces a previous "subtract the default branch's recent SHAs"
    // heuristic. That heuristic could not tell a branch with no commits apart
    // from one whose base was older than the fetched window, and it fell back to
    // the default branch's latest committer — which sent creator emails to
    // whoever happened to push to the base branch last.
    const ownCommits: GitLabCommitDto[] = branch.name === defaultBranch
      ? []
      : await this.gitlab.compareCommits(projectId, defaultBranch, branch.name, config)
    const firstOwn = ownCommits
      .filter((commit) => commit.author_name || commit.author_login || commit.author_email || commit.committer_name || commit.committer_login || commit.committer_email)
      .sort((a, b) => {
        const aTime = new Date(a.committed_date || a.authored_date || a.created_at || 0).getTime()
        const bTime = new Date(b.committed_date || b.authored_date || b.created_at || 0).getTime()
        return aTime - bTime
      })[0] ?? null
    const creatorEvent = branchCreators.get(branch.name) ?? null

    // A creation event is the only authoritative remote creator source. The
    // branch-only and tip commits remain useful for age and last-author data,
    // but must never be presented as the creator.
    const cachedCreator = (() => {
      if (!existing?.data_json) return null
      try {
        return sanitizeCreatorInfo((JSON.parse(String(existing.data_json)) as BranchSummary).creator)
      } catch {
        return null
      }
    })()
    const fallbackCreator = eventState.status !== 'available' && cachedCreator && hasVerifiedCreatorEmail(cachedCreator)
      ? cachedCreator
      : null
    const { creator } = fallbackCreator
      ? { creator: fallbackCreator }
      : resolveRemoteCreator(firstOwn, creatorEvent, latestCommit ?? null)
    const identityNames = [
      creatorEvent?.username,
      latestCommit?.author_login,
      latestCommit?.committer_login,
    ].filter((value): value is string => Boolean(value && value.trim()))
    const emailByUsername = typeof this.gitlab.resolveUserEmails === 'function'
      ? await this.gitlab.resolveUserEmails(identityNames, config)
      : new Map<string, string>()
    const lastAuthor = [
      latestCommit?.author_name,
      latestCommit?.author_login,
      latestCommit?.committer_name,
      latestCommit?.committer_login
    ].find((value) => Boolean(value?.trim()))?.trim() ?? ''

    const lastAuthorEmail = latestCommit?.author_email?.trim()
      || emailForUsername(emailByUsername, latestCommit?.author_login)
      || emailForUsername(emailByUsername, latestCommit?.committer_login)
      || latestCommit?.committer_email?.trim()
    // The event author's profile email is the primary proof. As a second
    // account-level proof, accept a commit email when the forge resolved that
    // commit to the same account that created the branch. A shared display
    // name alone is never enough.
    const verifiedCreator = creatorEmailFromIdentityChain(creator, creatorEvent, firstOwn, emailByUsername)
    // creatorEmailFromCommits only accepts commits whose forge login matches
    // the creation event's username, so it can extend the verified chain but
    // cannot silently replace it.
    const verifiedCommit = creatorEmailFromCommits(creatorEvent, [...ownCommits, ...recentCommits]).email
      ? creatorEmailFromCommits(creatorEvent, [...ownCommits, ...recentCommits])
      : creatorEvent?.username
        ? emailFromMatchingCommit(creatorEvent.username, [...ownCommits, ...recentCommits])
        : { email: '', source: '' as const }
    // A hidden profile, a forbidden private-email endpoint and a transient
    // account lookup all leave the same question open. The GitLab resolver
    // still verifies every candidate commit against the exact account id or
    // login before using its address, so attempt it for any unresolved creator.
    const accountBoundCommit = !verifiedCreator.email && typeof this.gitlab.resolveCreatorCommitEmail === 'function'
      ? await this.gitlab.resolveCreatorCommitEmail(projectId, branch.name, creator, [...ownCommits, ...recentCommits], config)
      : { email: '' }
    const verifiedCreatorEmail = verifiedCreator.email || verifiedCommit.email || accountBoundCommit.email
    const verifiedSource = verifiedCreator.source || verifiedCommit.source || (accountBoundCommit.email ? 'commit' : '')
    const baseResolution = creator.emailResolution?.status === 'events-unavailable'
      ? creator.emailResolution
      : eventState.status === 'unavailable'
        ? {
            status: 'events-unavailable' as const,
            retryable: eventState.retryable,
            checkedAt: eventState.checkedAt,
            ...(eventState.detail ? { detail: eventState.detail } : {})
          }
        : creator.emailResolution ?? {
            status: 'creation-event-missing' as const,
            retryable: true,
            checkedAt: new Date().toISOString()
          }
    // A commit lookup that simply finds nothing must not erase a more specific
    // account-side reason (for example, the private email endpoint is
    // admin-only). A real commit-lookup failure is more recent and wins.
    const unresolvedResolution = accountBoundCommit.resolution?.status === 'account-email-hidden'
      ? baseResolution
      : accountBoundCommit.resolution ?? baseResolution
    const resolvedCreator = sanitizeCreatorInfo({
      ...creator,
      email: verifiedCreatorEmail,
      emailSource: verifiedSource,
      emailResolution: verifiedCreatorEmail ? verifiedResolution(verifiedSource) : unresolvedResolution
    })

    const lastCommitAt = latestCommit?.committed_date ?? latestCommit?.authored_date ?? latestCommit?.created_at ?? null
    const oldestFetched = commits.length > 0
      ? (commits[commits.length - 1]?.committed_date ?? commits[commits.length - 1]?.authored_date ?? commits[commits.length - 1]?.created_at ?? null)
      : null
    const createdAt = creatorEvent?.createdAt ?? firstOwn?.committed_date ?? firstOwn?.authored_date ?? oldestFetched ?? latestCommit?.created_at ?? null
    const ref: GitRefInfo = {
      fullRef: `refs/remotes/origin/${branch.name}`,
      refType: 'remotes',
      name: branch.name,
      remote: 'origin',
      sha: latestCommit?.id ?? '',
      committedAt: lastCommitAt ?? '',
      authorName: lastAuthor,
      authorEmail: lastAuthorEmail ?? '',
      subject: latestCommit?.title ?? ''
    }
    const facts: AnalysisFacts = {
      name: branch.name,
      type: 'remote',
      remote: 'origin',
      existsLocally: false,
      existsRemotely: true,
      isHead: false,
      creator: resolvedCreator,
      createdAt,
      lastCommitAt,
      lastCommitSha: latestCommit?.id ?? '',
      lastAuthor,
      lastAuthorEmail: lastAuthorEmail ?? '',
      commitCount: commits.length,
      ahead: ownCommits.length,
      behind: 0,
      merged: branch.merged === true || ownCommits.length === 0,
      mergedInto: branch.merged || ownCommits.length === 0 ? defaultBranch : null,
      baseBranch: defaultBranch,
      recentCommits: recentCommits.map((c) => this.gitLabCommitToInfo(c))
    }
    const result = this.buildFromFacts(facts, ref, repo.id, monitoring)
    await this.storage.run(
      `INSERT INTO branch_snapshots (key, sha, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET sha = excluded.sha, updated_at = excluded.updated_at`,
      [cacheKey, cacheContentKey, new Date().toISOString()]
    )
    return result
  }

  private refExistsLocally(refs: GitRefInfo[], name: string): boolean {
    return refs.some((r) => r.name === name)
  }

  private async analyzeRef(
    repositoryId: string,
    repoPath: string,
    ref: GitRefInfo,
    currentBranch: string,
    defaultBranch: string,
    defaultRef: string,
    monitoring: MonitoringConfig,
    fp: string
  ): Promise<BranchSummary[]> {
    const type = ref.refType === 'heads' ? 'local' : 'remote'
    const cacheKey = `${repositoryId}|${type}|${ref.name}`
    const snapshot = this.storage.get<Record<string, unknown>>('SELECT sha FROM branch_snapshots WHERE key = ?', [cacheKey])
    const cacheContentKey = `v20|${ref.sha}|${fp}`
    const existing = this.storage.get<Record<string, unknown>>('SELECT data_json FROM branches WHERE key = ?', [cacheKey])

    if (snapshot?.sha === cacheContentKey && existing?.data_json) {
      try {
        const cached = JSON.parse(String(existing.data_json)) as BranchSummary
        return [this.refreshComputed(backfillCachedCreatorEmail(cached), monitoring, ref, currentBranch)]
      } catch {
        /* fall through to full analysis */
      }
    }

    const facts = await this.collectFacts(repoPath, ref, currentBranch, defaultBranch, defaultRef, monitoring)
    await this.storage.run(
      `INSERT INTO branch_snapshots (key, sha, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET sha = excluded.sha, updated_at = excluded.updated_at`,
      [cacheKey, cacheContentKey, new Date().toISOString()]
    )
    const branch = this.buildFromFacts(facts, ref, repositoryId, monitoring)
    return [branch]
  }

  private async collectFacts(
    repoPath: string,
    ref: GitRefInfo,
    currentBranch: string,
    defaultBranch: string,
    defaultRef: string,
    monitoring: MonitoringConfig
  ): Promise<AnalysisFacts> {
    const type = ref.refType === 'heads' ? 'local' : 'remote'
    const localName = type === 'local' ? ref.name : ref.name
    const fullRef = ref.fullRef
    const existsLocally = type === 'local' ? true : await this.git.refExists(repoPath, refForLocal(repoPath, localName))
    const existsRemotely = type === 'remote' ? true : await this.git.refExists(repoPath, refForRemote(ref.remote ?? 'origin', ref.name))

    const countPromise = this.git.countCommits(repoPath, fullRef)
    const aheadBehindPromise = this.git.aheadBehind(repoPath, defaultRef, fullRef)
    const mergeBasePromise = this.git.mergeBase(repoPath, defaultRef, fullRef)
    const recentCommitsPromise = this.git.lastCommits(repoPath, fullRef, 100)
    const [commitCount, aheadBehind, mergeBase, recentCommits] = await Promise.all([
      countPromise,
      aheadBehindPromise,
      mergeBasePromise,
      recentCommitsPromise
    ])

    const firstCommit = await this.git.firstDivergentCommit(repoPath, defaultRef, fullRef, mergeBase)
    const isHead = type === 'local' && ref.name === currentBranch

    const creator: BranchSummary['creator'] = firstCommit
      ? {
          name: firstCommit.authorName,
          email: '',
          emailSource: '',
          emailResolution: {
            status: 'creation-event-missing',
            retryable: true,
            checkedAt: new Date().toISOString()
          },
          firstCommitAt: firstCommit.committedAt,
          confidence: 'medium'
        }
      : {
          name: 'Unknown',
          email: '',
          emailSource: '',
          emailResolution: {
            status: 'creation-event-missing',
            retryable: true,
            checkedAt: new Date().toISOString()
          },
          firstCommitAt: null,
          confidence: 'unknown'
        }

    const createdAt = firstCommit?.committedAt ?? ref.committedAt
    const mergedInto = aheadBehind.ahead === 0 ? defaultBranch : null

    return {
      name: ref.name,
      type,
      remote: ref.remote,
      existsLocally,
      existsRemotely,
      isHead,
      creator,
      createdAt,
      lastCommitAt: ref.committedAt || null,
      lastCommitSha: ref.sha,
      lastAuthor: ref.authorName,
      lastAuthorEmail: ref.authorEmail,
      commitCount,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      merged: aheadBehind.ahead === 0,
      mergedInto,
      baseBranch: defaultBranch,
      recentCommits
    }
  }

  private buildFromFacts(
    facts: AnalysisFacts,
    ref: GitRefInfo,
    repositoryId: string,
    monitoring: MonitoringConfig
  ): BranchSummary {
    const now = Date.now()
    const inactiveDays = elapsedDays(facts.lastCommitAt, now)
    const ageDays = elapsedDays(facts.createdAt, now)
    // 前缀规则优先，未命中时回落到全局阈值；两处生命周期判定共用 effectiveThreshold()，
    // 避免新扫描与缓存刷新各算一套。
    const effective = effectiveThreshold(monitoring, facts.name)
    const thresholdHours = effective.hours
    const inactiveHours = elapsedHours(facts.lastCommitAt, now)
    const baseline = isBaselineBranch(facts.name, facts.baseBranch)
    const stale = !baseline && inactiveHours >= thresholdHours
    const state: BranchState = stale ? 'stale' : 'active'
    const naming: NamingResult = monitoring.namingEnabled
      ? this.naming.validate(facts.name, this.naming.listRules(repositoryId))
      : { status: 'excluded', reason: 'Naming validation disabled.' }
    const isDefault = ref.name === facts.baseBranch
    const protection: ProtectionInfo = this.protection.evaluate(facts.name, isDefault, repositoryId)
    const health: HealthResult = this.health.compute({
      inactiveDays,
      staleThresholdDays: Math.max(thresholdHours / 24, 1 / 1440),
      state,
      namingStatus: naming.status,
      namingExempt: facts.name === 'main' || facts.name === 'develop' || facts.name === 'develop_XC',
      branchName: facts.name,
      baseBranch: facts.baseBranch,
      merged: facts.merged,
      ahead: facts.ahead,
      behind: facts.behind,
      whitelisted: protection.whitelisted,
      isDefault: protection.isDefault,
      protected: protection.protected
    })

    return {
      id: newId(),
      repositoryId,
      repositoryName: '',
      name: facts.name,
      displayName: facts.type === 'remote' ? `${facts.remote}/${facts.name}` : facts.name,
      type: facts.type,
      remote: facts.remote,
      existsLocally: facts.existsLocally,
      existsRemotely: facts.existsRemotely,
      isHead: facts.isHead,
      creator: facts.creator,
      createdAt: facts.createdAt,
      lastCommitAt: facts.lastCommitAt,
      lastCommitSha: facts.lastCommitSha,
      lastAuthor: facts.lastAuthor,
      lastAuthorEmail: facts.lastAuthorEmail,
      commitCount: facts.commitCount,
      ahead: facts.ahead,
      behind: facts.behind,
      merged: facts.merged,
      mergedInto: facts.mergedInto,
      baseBranch: facts.baseBranch,
      inactiveDays,
      ageDays,
      naming,
      health,
      protection,
      state,
      stale,
      thresholdDays: Math.max(effective.hours / 24, 1 / 1440),
      thresholdUnit: effective.unit,
      cleanupCandidate: stale && !protection.whitelisted && !protection.isDefault && !protection.protected,
      recentCommits: facts.recentCommits,
      lastScannedAt: new Date().toISOString()
    }
  }

  private refreshComputed(cached: BranchSummary, monitoring: MonitoringConfig, ref: GitRefInfo, currentBranch: string): BranchSummary {
    cached = backfillCachedCreatorEmail(cached)
    const now = Date.now()
    const inactiveDays = elapsedDays(cached.lastCommitAt, now)
    const ageDays = elapsedDays(cached.createdAt, now)
    const effective = effectiveThreshold(monitoring, cached.name)
    const thresholdHours = effective.hours
    const inactiveHours = elapsedHours(cached.lastCommitAt, now)
    const baseline = isBaselineBranch(cached.name, cached.baseBranch)
    const stale = !baseline && inactiveHours >= thresholdHours
    const state: BranchState = stale ? 'stale' : 'active'
    const naming: NamingResult = monitoring.namingEnabled
      ? this.naming.validate(cached.name, this.naming.listRules(cached.repositoryId))
      : { status: 'excluded', reason: 'Naming validation disabled.' }
    const isDefault = cached.name === cached.baseBranch
    const protection: ProtectionInfo = this.protection.evaluate(cached.name, isDefault, cached.repositoryId)
    const health: HealthResult = this.health.compute({
      inactiveDays,
      staleThresholdDays: Math.max(thresholdHours / 24, 1 / 1440),
      state,
      namingStatus: naming.status,
      namingExempt: cached.name === 'main' || cached.name === 'develop' || cached.name === 'develop_XC',
      branchName: cached.name,
      baseBranch: cached.baseBranch,
      merged: cached.merged,
      ahead: cached.ahead,
      behind: cached.behind,
      whitelisted: protection.whitelisted,
      isDefault: protection.isDefault,
      protected: protection.protected
    })

    return {
      ...cached,
      repositoryId: cached.repositoryId,
      inactiveDays,
      ageDays,
      state,
      stale,
      thresholdDays: Math.max(effective.hours / 24, 1 / 1440),
      thresholdUnit: effective.unit,
      cleanupCandidate: stale && !protection.whitelisted && !protection.isDefault && !protection.protected,
      naming,
      protection,
      health,
      isHead: cached.type === 'local' && cached.name === currentBranch,
      lastScannedAt: new Date().toISOString()
    }
  }

  listBranches(repositoryIds?: string[]): BranchSummary[] {
    const repos = new Map(this.repositoryService.list().map((r) => [r.id, r.name]))
    const rows = this.storage.all<Record<string, unknown>>('SELECT data_json, repository_id FROM branches ORDER BY name ASC')
    const branches = rows.map((row) => {
      try {
        const repositoryId = String(row.repository_id ?? '')
        const parsed = JSON.parse(String(row.data_json)) as BranchSummary
        parsed.repositoryName = repos.get(repositoryId) ?? ''
        const monitoring = this.monitoring(repositoryId)
        return this.refreshComputed(parsed, monitoring, { name: parsed.name } as GitRefInfo, '')
      } catch {
        return null
      }
    }).filter((b): b is BranchSummary => b !== null)
    return repositoryIds === undefined ? branches : branches.filter((branch) => repositoryIds.includes(branch.repositoryId))
  }

  async getBranch(criteria: BranchCriteria, repositoryIds?: string[]): Promise<BranchSummary | null> {
    const key = `${criteria.repositoryId}|${criteria.type}|${criteria.name}`
    const row = this.storage.get<Record<string, unknown>>('SELECT data_json, repository_id FROM branches WHERE key = ?', [key])
    if (!row) return null
    const allowed = repositoryIds === undefined || repositoryIds.includes(criteria.repositoryId)
    if (!allowed) return null
    const repo = this.repositoryService.get(criteria.repositoryId)
    const parsed = JSON.parse(String(row.data_json)) as BranchSummary
    parsed.repositoryName = repo?.name ?? ''
    if (repo && repo.source !== 'local' && repo.gitlabProjectId) {
      try {
        const commits = await this.gitlab.listCommits(repo.gitlabProjectId, criteria.name, 1, 20, remoteBranchConfig(repo, this.repositoryService.getRemoteToken(repo.id) || this.settingsService.getGitLabToken()))
        parsed.recentCommits = commits.map((c) => this.gitLabCommitToInfo(c))
        const latest = commits[0]
        if (latest) {
          parsed.lastAuthor = latest.author_name || latest.author_login || latest.author_email || ''
          parsed.lastAuthorEmail = latest.author_email || ''
          parsed.lastCommitAt = latest.committed_date ?? latest.authored_date ?? latest.created_at ?? parsed.lastCommitAt
        }
        parsed.existsLocally = false
        parsed.existsRemotely = true
      } catch {
        parsed.recentCommits = []
      }
    } else if (repo) {
      parsed.recentCommits = []
      parsed.existsLocally = false
      parsed.existsRemotely = repo.source !== 'local'
    }
    const monitoring = this.monitoring(criteria.repositoryId)
    return this.refreshComputed(parsed, monitoring, { name: criteria.name } as GitRefInfo, '')
  }

  private gitLabCommitToInfo(commit: GitLabCommitDto): CommitInfo {
    return {
      sha: commit.id,
      shortSha: commit.short_id,
      authorName: commit.author_name,
      authorEmail: commit.author_email,
      committedAt: commit.committed_date ?? commit.authored_date ?? commit.created_at,
      subject: commit.title ?? commit.message?.split('\n')[0] ?? ''
    }
  }

}

function creatorKeyForCache(creator: BranchCreatorDto | undefined): string {
  return creator
    ? [
        creator.username,
        creator.name,
        creator.email,
        creator.emailSource,
        creator.accountId ?? creator.userId ?? '',
        creator.emailResolution?.status ?? '',
        creator.emailResolution?.retryable ?? '',
        creator.createdAt ?? ''
      ].join('|')
    : 'unknown'
}
