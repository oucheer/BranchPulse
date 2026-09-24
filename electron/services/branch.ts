import type {
  BranchCriteria,
  BranchState,
  BranchSummary,
  CommitInfo,
  HealthResult,
  MonitoringConfig,
  NamingResult,
  ProtectionInfo,
  Repository
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
import type { BranchCreatorDto, GitLabBranchDto, GitLabCommitDto, GitLabService } from './gitlab'
import { newId } from '../utils/ids'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Decide who created a remote branch.
 *
 * Match main: prefer the oldest commit unique to the branch, then use an
 * explicit forge branch-creation event when the branch has no own commits.
 * Commit authors are candidates, not proof of who created the ref.
 *
 * Exported for unit tests; the attribution rules are easy to regress and hard to
 * observe end to end.
 */
export function resolveRemoteCreator(
  firstOwnCommit: GitLabCommitDto | null,
  creationEvent: BranchCreatorDto | null,
  branchTip: GitLabCommitDto | null = null
): { creator: { name: string; email: string; firstCommitAt: string | null; confidence: 'high' | 'medium' | 'low' | 'unknown' } } {
  const commitCandidate = firstOwnCommit ?? branchTip
  const candidateName = commitCandidate?.author_name || commitCandidate?.author_login || commitCandidate?.author_email || commitCandidate?.committer_name || commitCandidate?.committer_login || commitCandidate?.committer_email
  if (commitCandidate && candidateName && firstOwnCommit) {
    return {
      creator: {
        name: candidateName,
        email: commitCandidate.author_email || commitCandidate.committer_email,
        firstCommitAt: commitCandidate.committed_date ?? commitCandidate.authored_date ?? commitCandidate.created_at ?? null,
        confidence: 'low'
      }
    }
  }
  if (creationEvent) {
    return {
      creator: {
        name: creationEvent.name,
        email: creationEvent.email,
        firstCommitAt: creationEvent.createdAt,
        confidence: creationEvent.email ? 'high' : 'medium'
      }
    }
  }
  if (commitCandidate && candidateName) {
    return {
      creator: {
        name: candidateName,
        email: commitCandidate.author_email || commitCandidate.committer_email,
        firstCommitAt: commitCandidate.committed_date ?? commitCandidate.authored_date ?? commitCandidate.created_at ?? null,
        confidence: 'low'
      }
    }
  }
  return { creator: { name: 'Unknown', email: '', firstCommitAt: null, confidence: 'unknown' } }
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
  return `${monitoring.staleThresholdUnit}|${monitoring.staleThresholdDays}|${rules}|${wl}|${pr}`
}

function thresholdToHours(value: number, unit: MonitoringConfig['staleThresholdUnit']): number {
  if (unit === 'minutes') return value / 60
  if (unit === 'hours') return value
  if (unit === 'weeks') return value * 24 * 7
  return value * 24
}

/**
 * 基准分支（main / develop / 仓库默认分支）是所有分支的评分参照物，
 * 不参与生命周期评比：不计已停更、不进清理候选、不进需要关注的列表。
 */
export function isBaselineBranch(name: string, baseBranch?: string | null): boolean {
  if (/^(main|develop)$/i.test(name)) return true
  return Boolean(baseBranch) && name === baseBranch
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

  /**
   * 监控配置按仓库严格隔离：只读取该仓库自己的 monitoring_rules_repo 记录，
   * 不做任何全局回退（未配置时使用内置默认值）。
   */
  private monitoring(repositoryId?: string | null): MonitoringConfig {
    const row = repositoryId
      ? this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules_repo WHERE repository_id = ?', [repositoryId])
      : null
    return {
      enabled: (row?.enabled ?? 1) === 1,
      staleThresholdDays: Number(row?.stale_threshold_days ?? 180),
      staleThresholdUnit: ((row?.stale_threshold_unit as MonitoringConfig['staleThresholdUnit']) ?? 'days'),
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
    const branchCreators = await this.gitlab.listBranchCreators(projectId, remoteConfig)
    const analyzed: BranchSummary[] = []
    const failedBranches: Array<{ name: string; reason: string }> = []
    const batchSize = 6
    for (let i = 0; i < branches.length; i += batchSize) {
      const batch = branches.slice(i, i + batchSize)
      // One flaky branch (a proxy hiccup, a 429, a slow compare) must never turn
      // the whole repository into "0 branches": settle every branch in the batch
      // and keep the ones that succeeded. This is the difference between an
      // intranet instance with a few shaky branches and a repository that looks
      // unreachable even though its branches are readable.
      const results = await Promise.allSettled(
        batch.map((branch) => this.analyzeGitLabBranch(repo, projectId, branch, defaultBranch, branchCreators, monitoring, fp, remoteConfig))
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
    }
    // Every branch failing means the forge was unreachable for this repository,
    // not that the repository is empty — report it so the run records a reason.
    if (analyzed.length === 0 && branches.length > 0) {
      const sample = failedBranches.slice(0, 3).map((item) => `${item.name}（${item.reason}）`).join('；')
      throw new Error(`${branches.length} 个分支全部分析失败：${sample}`)
    }

    const missingAuthorNames = analyzed
      .filter((branch) => !branch.lastAuthorEmail || !branch.creator.email)
      .flatMap((branch) => [branch.lastAuthor, branch.creator.name])
      .filter((name) => name && name !== 'Unknown')
    if (missingAuthorNames.length > 0 && typeof this.gitlab.resolveUserEmailsByNames === 'function') {
      const emailByName = await this.gitlab.resolveUserEmailsByNames(missingAuthorNames, remoteConfig)
      for (const branch of analyzed) {
        const lastAuthorEmail = branch.lastAuthorEmail || emailByName.get(branch.lastAuthor)
        const creatorEmail = branch.creator.email || emailByName.get(branch.creator.name)
        if (lastAuthorEmail || creatorEmail) {
          branch.lastAuthorEmail = lastAuthorEmail || branch.lastAuthorEmail
          branch.creator = { ...branch.creator, email: creatorEmail || branch.creator.email }
        }
      }
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
      repositoryId: repo.id,
      repository: repo.name,
      source: repo.source,
      branches: analyzed.length,
      stale: analyzed.filter((b) => b.stale).length,
      namingInvalid: analyzed.filter((b) => b.naming.status === 'invalid').length,
      merged: analyzed.filter((b) => b.merged).length
    })
    return analyzed
  }

  private async analyzeGitLabBranch(
    repo: Repository,
    projectId: number,
    branch: GitLabBranchDto,
    defaultBranch: string,
    branchCreators: Map<string, BranchCreatorDto>,
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
    // v10: use main's commit-first attribution order and expose candidates as inferred.
    const creatorKey = creatorKeyForCache(branchCreators.get(branch.name))
    const cacheContentKey = `v10|${latestCommit?.id ?? ''}|${creatorKey}|${fp}`
    const existing = this.storage.get<Record<string, unknown>>('SELECT data_json FROM branches WHERE key = ?', [cacheKey])
    const snapshot = this.storage.get<Record<string, unknown>>('SELECT sha FROM branch_snapshots WHERE key = ?', [cacheKey])
    if (snapshot?.sha === cacheContentKey && existing?.data_json) {
      try {
        const cached = JSON.parse(String(existing.data_json)) as BranchSummary
        if (cached.lastAuthorEmail || cached.creator.email || (!cached.lastAuthor && cached.creator.name === 'Unknown')) {
          return this.refreshComputed(cached, monitoring, { name: branch.name } as GitRefInfo, '')
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

    // Commits this branch has and the default branch does not. These establish
    // ahead/merged state, but their authors are not necessarily branch creators.
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

    // Match main's branch-only commit first. If neither that nor a forge event
    // identifies a creator, show the branch tip author as an explicitly inferred fallback.
    const { creator } = resolveRemoteCreator(firstOwn, creatorEvent, latestCommit ?? null)
    const identityNames = [
      latestCommit?.author_login,
      latestCommit?.committer_login,
      firstOwn?.author_login,
      firstOwn?.committer_login,
      creatorEvent?.username
    ].filter((value): value is string => Boolean(value && value.trim()))
    const emailByUsername = typeof this.gitlab.resolveUserEmails === 'function'
      ? await this.gitlab.resolveUserEmails(identityNames, config)
      : new Map<string, string>()
    const creatorEmail = creator.email || emailForUsername(emailByUsername, creatorEvent?.username)
      || emailForUsername(emailByUsername, firstOwn?.author_login)
      || emailForUsername(emailByUsername, firstOwn?.committer_login)
    const resolvedCreator = creatorEmail ? { ...creator, email: creatorEmail } : creator
    const lastAuthorEmail = latestCommit?.author_email
      || emailForUsername(emailByUsername, latestCommit?.author_login)
      || emailForUsername(emailByUsername, latestCommit?.committer_login)

    const lastCommitAt = latestCommit?.committed_date ?? latestCommit?.authored_date ?? latestCommit?.created_at ?? null
    const oldestFetched = commits.length > 0
      ? (commits[commits.length - 1]?.committed_date ?? commits[commits.length - 1]?.authored_date ?? commits[commits.length - 1]?.created_at ?? null)
      : null
    const createdAt = firstOwn?.committed_date ?? firstOwn?.authored_date ?? creatorEvent?.createdAt ?? oldestFetched ?? latestCommit?.created_at ?? null
    const ref: GitRefInfo = {
      fullRef: `refs/remotes/origin/${branch.name}`,
      refType: 'remotes',
      name: branch.name,
      remote: 'origin',
      sha: latestCommit?.id ?? '',
      committedAt: lastCommitAt ?? '',
      authorName: latestCommit?.author_name ?? latestCommit?.author_login ?? '',
      authorEmail: latestCommit?.author_email ?? '',
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
      lastAuthor: latestCommit?.author_name ?? latestCommit?.author_login ?? '',
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
    const cacheContentKey = `v8|${ref.sha}|${fp}`
    const existing = this.storage.get<Record<string, unknown>>('SELECT data_json FROM branches WHERE key = ?', [cacheKey])

    if (snapshot?.sha === cacheContentKey && existing?.data_json) {
      try {
        const cached = JSON.parse(String(existing.data_json)) as BranchSummary
        return [this.refreshComputed(cached, monitoring, ref, currentBranch)]
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
          email: firstCommit.authorEmail,
          firstCommitAt: firstCommit.committedAt,
          confidence: mergeBase ? 'high' : 'medium'
        }
      : { name: 'Unknown', email: '', firstCommitAt: null, confidence: 'unknown' }

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
    const thresholdHours = thresholdToHours(monitoring.staleThresholdDays, monitoring.staleThresholdUnit)
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
      namingExempt: facts.name === 'main' || facts.name === 'develop',
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
      cleanupCandidate: stale && !protection.whitelisted && !protection.isDefault && !protection.protected,
      recentCommits: facts.recentCommits,
      lastScannedAt: new Date().toISOString()
    }
  }

  private refreshComputed(cached: BranchSummary, monitoring: MonitoringConfig, ref: GitRefInfo, currentBranch: string): BranchSummary {
    const now = Date.now()
    const inactiveDays = elapsedDays(cached.lastCommitAt, now)
    const ageDays = elapsedDays(cached.createdAt, now)
    const thresholdHours = thresholdToHours(monitoring.staleThresholdDays, monitoring.staleThresholdUnit)
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
      namingExempt: cached.name === 'main' || cached.name === 'develop',
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
      cleanupCandidate: stale && !protection.whitelisted && !protection.isDefault && !protection.protected,
      naming,
      protection,
      health,
      isHead: cached.type === 'local' && cached.name === currentBranch,
      lastScannedAt: new Date().toISOString()
    }
  }

  listBranches(repositoryIds?: string[]): BranchSummary[] {
    const selected = repositoryIds ?? this.storage.selectedRepositoryIds()
    if (!selected.length) return []
    const scope = new Set(selected.filter((id) => this.repositoryService.get(id)))
    if (!scope.size) return []
    const placeholders = selected.map(() => '?').join(', ')
    const repos = new Map(this.repositoryService.list().map((r) => [r.id, r.name]))
    const rows = this.storage.all<Record<string, unknown>>(
      `SELECT data_json, repository_id FROM branches WHERE repository_id IN (${placeholders}) ORDER BY name ASC`,
      selected
    )
    return rows.map((row) => {
      try {
        const repositoryId = String(row.repository_id ?? '')
        const parsed = JSON.parse(String(row.data_json)) as BranchSummary
        if (!scope.has(repositoryId)) return null
        parsed.repositoryName = repos.get(repositoryId) ?? ''
        const monitoring = this.monitoring(repositoryId)
        return this.refreshComputed(parsed, monitoring, { name: parsed.name } as GitRefInfo, '')
      } catch {
        return null
      }
    }).filter((b): b is BranchSummary => b !== null)
  }

  async getBranch(criteria: BranchCriteria, repositoryIds?: string[]): Promise<BranchSummary | null> {
    // 直接访问详情也必须落在当前勾选范围内，否则一律返回空状态。
    const selected = repositoryIds ?? this.storage.selectedRepositoryIds()
    if (!new Set(selected).has(criteria.repositoryId)) return null
    const key = `${criteria.repositoryId}|${criteria.type}|${criteria.name}`
    const row = this.storage.get<Record<string, unknown>>('SELECT data_json, repository_id FROM branches WHERE key = ?', [key])
    if (!row) return null
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
  return creator ? `${creator.username}|${creator.name}|${creator.email}|${creator.createdAt ?? ''}` : 'unknown'
}
