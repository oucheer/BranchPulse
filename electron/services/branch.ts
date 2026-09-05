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
import type { GitLabBranchDto, GitLabCommitDto, GitLabService } from './gitlab'
import { newId } from '../utils/ids'

const DAY_MS = 24 * 60 * 60 * 1000

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
  commitCount: number
  ahead: number
  behind: number
  merged: boolean
  mergedInto: string | null
  baseBranch: string
  gracePeriodDays: number
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

function safeTimestamp(value: string | null | undefined): number {
  if (!value) return Date.now()
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Date.now()
}
function fingerprint(monitoring: MonitoringConfig, naming: NamingService, protection: ProtectionService): string {
  const rules = naming
    .listRules()
    .map((r) => `${r.id}:${r.enabled}:${r.mode}:${r.type}:${r.pattern}`)
    .join('|')
  const wl = protection.listWhitelist().map((e) => `${e.type}:${e.pattern}`).join('|')
  const pr = protection.listProtected().map((e) => `${e.type}:${e.pattern}`).join('|')
  return `${monitoring.staleThresholdDays}|${monitoring.gracePeriodDays}|${rules}|${wl}|${pr}`
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

  private monitoring(): MonitoringConfig {
    const row = this.storage.get<Record<string, unknown>>('SELECT * FROM monitoring_rules WHERE id = 1')
    return {
      staleThresholdDays: Number(row?.stale_threshold_days ?? 14),
      gracePeriodDays: Number(row?.grace_period_days ?? 7),
      fetchEnabled: (row?.fetch_enabled ?? 1) === 1,
      namingEnabled: (row?.naming_enabled ?? 1) === 1,
      emailPolicy: ((row?.email_policy as MonitoringConfig['emailPolicy']) ?? 'none') as MonitoringConfig['emailPolicy'],
      notificationEnabled: (row?.notification_enabled ?? 1) === 1,
      autoDeleteEnabled: Number(row?.auto_delete_enabled ?? 0) === 1,
      notifyTarget: ((row?.notify_target as MonitoringConfig['notifyTarget']) ?? 'self')
    }
  }

  async scanRepository(repositoryId: string, options: RepositoryScanOptions = {}): Promise<BranchSummary[]> {
    const repo = this.repositoryService.get(repositoryId)
    if (!repo) throw new Error('Repository not found.')
    if (repo.source === 'gitlab' || repo.source === 'github' || repo.source === 'gitee') {
      return this.scanGitLabRepository(repo, options)
    }
    throw new Error('BranchPulse 现在只通过远程仓库 API 扫描，请添加远程仓库。')
  }

  private async scanGitLabRepository(repo: Repository, options: RepositoryScanOptions = {}): Promise<BranchSummary[]> {
    const progress = options.progress ?? ((): void => undefined)
    const monitoring = this.monitoring()
    const fp = fingerprint(monitoring, this.naming, this.protection)
    const projectId = repo.gitlabProjectId
    if (!projectId) throw new Error('GitLab project id is missing for this repository.')

    progress('Fetching GitLab branches...')
    const remoteConfig = remoteBranchConfig(repo, this.repositoryService.getRemoteToken(repo.id) || this.settingsService.getGitLabToken())
    const branches = await this.gitlab.listBranches(projectId, remoteConfig)
    const defaultBranch = repo.defaultBranch || branches.find((b) => b.default)?.name || 'main'
    progress(`Analyzing ${branches.length} GitLab branches...`)
    const defaultShas = new Set(await this.gitlabCommitShas(projectId, defaultBranch, 5, remoteConfig))
    const analyzed: BranchSummary[] = []
    const batchSize = 6
    for (let i = 0; i < branches.length; i += batchSize) {
      const batch = branches.slice(i, i + batchSize)
      const results = await Promise.all(
        batch.map((branch) => this.analyzeGitLabBranch(repo, projectId, branch, defaultBranch, defaultShas, monitoring, fp, remoteConfig))
      )
      analyzed.push(...results)
      progress(`Analyzed ${Math.min(i + batchSize, branches.length)} of ${branches.length} branches...`)
    }

    this.storage.transaction(() => {
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
    return analyzed
  }

  private async gitlabCommitShas(projectId: number, refName: string, maxPages = 5, config?: GitLabConnectionConfig): Promise<string[]> {
    const shas: string[] = []
    for (let page = 1; page <= maxPages; page += 1) {
      const pageCommits = await this.gitlab.listCommits(projectId, refName, page, 100, config)
      shas.push(...pageCommits.map((c) => c.id))
      if (pageCommits.length < 100) break
    }
    return shas
  }

  private async analyzeGitLabBranch(
    repo: Repository,
    projectId: number,
    branch: GitLabBranchDto,
    defaultBranch: string,
    defaultShas: Set<string>,
    monitoring: MonitoringConfig,
    fp: string,
    config?: GitLabConnectionConfig
  ): Promise<BranchSummary> {
    const cacheKey = `${repo.id}|remote|${branch.name}`
    const latestCommit = branch.commit
    const cacheContentKey = `${latestCommit?.id ?? ''}|${fp}`
    const existing = this.storage.get<Record<string, unknown>>('SELECT data_json FROM branches WHERE key = ?', [cacheKey])
    const snapshot = this.storage.get<Record<string, unknown>>('SELECT sha FROM branch_snapshots WHERE key = ?', [cacheKey])
    if (snapshot?.sha === cacheContentKey && existing?.data_json) {
      try {
        const cached = JSON.parse(String(existing.data_json)) as BranchSummary
        return this.refreshComputed(cached, monitoring, { name: branch.name } as GitRefInfo, '')
      } catch {
        /* fall through */
      }
    }

    const commits = await this.gitlab.listCommits(projectId, branch.name, 1, 100, config)
    const commitSet = new Set(commits.map((c) => c.id))
    const unique = commits.filter((c) => !defaultShas.has(c.id))
    const firstUnique = unique.length > 0 ? unique[unique.length - 1] : null
    const creator: BranchSummary['creator'] = firstUnique
      ? {
          name: firstUnique.author_name,
          email: firstUnique.author_email,
          firstCommitAt: firstUnique.committed_date ?? firstUnique.authored_date ?? null,
          confidence: 'medium'
        }
      : latestCommit
        ? {
            name: latestCommit.author_name,
            email: latestCommit.author_email,
            firstCommitAt: latestCommit.authored_date ?? latestCommit.committed_date ?? null,
            confidence: unique.length === 0 ? 'low' : 'medium'
          }
        : { name: 'Unknown', email: '', firstCommitAt: null, confidence: 'unknown' }

    const lastCommitAt = latestCommit?.committed_date ?? null
    const createdAt = firstUnique?.committed_date ?? latestCommit?.created_at ?? null
    const ref: GitRefInfo = {
      fullRef: `refs/remotes/origin/${branch.name}`,
      refType: 'remotes',
      name: branch.name,
      remote: 'origin',
      sha: latestCommit?.id ?? '',
      committedAt: lastCommitAt ?? '',
      authorName: latestCommit?.author_name ?? '',
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
      creator,
      createdAt,
      lastCommitAt,
      lastCommitSha: latestCommit?.id ?? '',
      lastAuthor: latestCommit?.author_name ?? '',
      commitCount: commits.length,
      ahead: unique.length,
      behind: 0,
      merged: branch.merged === true || unique.length === 0,
      mergedInto: branch.merged || unique.length === 0 ? defaultBranch : null,
      baseBranch: defaultBranch,
      gracePeriodDays: monitoring.gracePeriodDays
    }
    void commitSet
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
    const cacheContentKey = `${ref.sha}|${fp}`
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
    const [commitCount, aheadBehind, mergeBase] = await Promise.all([countPromise, aheadBehindPromise, mergeBasePromise])

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
      commitCount,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      merged: aheadBehind.ahead === 0,
      mergedInto,
      baseBranch: defaultBranch,
      gracePeriodDays: monitoring.gracePeriodDays
    }
  }

  private buildFromFacts(
    facts: AnalysisFacts,
    ref: GitRefInfo,
    repositoryId: string,
    monitoring: MonitoringConfig
  ): BranchSummary {
    const now = Date.now()
    const inactiveDays = Math.floor(Math.max(0, now - safeTimestamp(facts.lastCommitAt)) / DAY_MS)
    const ageDays = Math.floor(Math.max(0, now - safeTimestamp(facts.createdAt)) / DAY_MS)
    const stale = inactiveDays > monitoring.staleThresholdDays
    const graceExpired = stale && inactiveDays > monitoring.staleThresholdDays + monitoring.gracePeriodDays
    const state: BranchState = !stale ? 'active' : graceExpired ? 'grace_expired' : 'grace_period'
    const naming: NamingResult = monitoring.namingEnabled ? this.naming.validate(facts.name) : { status: 'excluded', reason: 'Naming validation disabled.' }
    const isDefault = ref.name === facts.baseBranch
    const protection: ProtectionInfo = this.protection.evaluate(facts.name, isDefault)
    const health: HealthResult = this.health.compute({
      inactiveDays,
      staleThresholdDays: monitoring.staleThresholdDays,
      gracePeriodDays: monitoring.gracePeriodDays,
      state,
      namingStatus: naming.status,
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
      gracePeriodDays: monitoring.gracePeriodDays,
      graceExpired,
      cleanupCandidate: graceExpired && !protection.whitelisted && !protection.isDefault && !protection.protected,
      recentCommits: [],
      lastScannedAt: new Date().toISOString()
    }
  }

  private refreshComputed(cached: BranchSummary, monitoring: MonitoringConfig, ref: GitRefInfo, currentBranch: string): BranchSummary {
    const now = Date.now()
    const inactiveDays = Math.floor(Math.max(0, now - safeTimestamp(cached.lastCommitAt)) / DAY_MS)
    const ageDays = Math.floor(Math.max(0, now - safeTimestamp(cached.createdAt)) / DAY_MS)
    const stale = inactiveDays > monitoring.staleThresholdDays
    const graceExpired = stale && inactiveDays > monitoring.staleThresholdDays + monitoring.gracePeriodDays
    const state: BranchState = !stale ? 'active' : graceExpired ? 'grace_expired' : 'grace_period'
    const naming: NamingResult = monitoring.namingEnabled ? this.naming.validate(cached.name) : { status: 'excluded', reason: 'Naming validation disabled.' }
    const isDefault = cached.name === cached.baseBranch
    const protection: ProtectionInfo = this.protection.evaluate(cached.name, isDefault)
    const health: HealthResult = this.health.compute({
      inactiveDays,
      staleThresholdDays: monitoring.staleThresholdDays,
      gracePeriodDays: monitoring.gracePeriodDays,
      state,
      namingStatus: naming.status,
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
      graceExpired,
      cleanupCandidate: graceExpired && !protection.whitelisted && !protection.isDefault && !protection.protected,
      naming,
      protection,
      health,
      isHead: cached.type === 'local' && cached.name === currentBranch,
      lastScannedAt: new Date().toISOString()
    }
  }

  listBranches(): BranchSummary[] {
    const repos = new Map(this.repositoryService.list().map((r) => [r.id, r.name]))
    const rows = this.storage.all<Record<string, unknown>>('SELECT data_json, repository_id FROM branches ORDER BY name ASC')
    const monitoring = this.monitoring()
    return rows.map((row) => {
      try {
        const parsed = JSON.parse(String(row.data_json)) as BranchSummary
        parsed.repositoryName = repos.get(String(row.repository_id)) ?? ''
        return this.refreshComputed(parsed, monitoring, { name: parsed.name } as GitRefInfo, '')
      } catch {
        return null
      }
    }).filter((b): b is BranchSummary => b !== null)
  }

  async getBranch(criteria: BranchCriteria): Promise<BranchSummary | null> {
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
    const monitoring = this.monitoring()
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

  async autoDeleteExpiredBranches(branches: BranchSummary[]): Promise<number> {
    const targets = branches.filter((b) => b.cleanupCandidate && b.existsRemotely)
    let deleted = 0
    for (const branch of targets) {
      const repo = this.repositoryService.get(branch.repositoryId)
      if (!repo) continue
      try {
        if (repo.source !== 'local' && repo.gitlabProjectId) {
          await this.gitlab.deleteBranch(repo.gitlabProjectId, branch.name, remoteBranchConfig(repo, this.repositoryService.getRemoteToken(repo.id) || this.settingsService.getGitLabToken()))
          this.deleteRemoteRecord({ repositoryId: branch.repositoryId, name: branch.name, type: 'remote' })
        } else {
          throw new Error('远程仓库配置不完整，无法通过 API 删除分支。')
        }
        this.audit.record('branch_auto_deleted', {
          repository: repo.name,
          branch: branch.name,
          source: repo.source,
          reason: 'grace_expired_auto_cleanup'
        })
        deleted += 1
      } catch (err) {
        this.audit.record('branch_auto_delete_failed', {
          repository: repo.name,
          branch: branch.name,
          error: err instanceof Error ? err.message : String(err)
        }, 'failure')
      }
    }
    return deleted
  }

  deleteLocalRecord(criteria: BranchCriteria): void {
    const key = `${criteria.repositoryId}|local|${criteria.name}`
    this.storage.delete('branches', 'key = ?', [key])
    this.storage.delete('branch_snapshots', 'key = ?', [key])
  }

  deleteRemoteRecord(criteria: BranchCriteria): void {
    const key = `${criteria.repositoryId}|remote|${criteria.name}`
    this.storage.delete('branches', 'key = ?', [key])
    this.storage.delete('branch_snapshots', 'key = ?', [key])
  }
}
