import type { StorageService } from './storage'
import type { GitLabService } from './gitlab'
import type { RepositoryService } from './repository'
import type { BranchService } from './branch'
import type { NamingService } from './naming'
import type {
  PersonalActivity, PersonalCommit, PersonalCommitFile, PersonalMergeRequest, PersonalRepositoryStats,
  PersonalSourceStats, PersonalStats, PersonalYearStats, RemoteRepositorySource, Repository, RepositorySource, UserSession
} from '@shared/types'
import { matchesUserToCreator } from '@shared/identity'
import { logger } from '../utils/logger'

interface CachedCommit { sha: string; shortSha: string; subject: string; committedAt: string; webUrl?: string }
interface CachedMergeRequest {
  id: number; iid: number; title: string; state: string
  sourceBranch: string; targetBranch: string; createdAt: string; webUrl?: string; role: 'author' | 'reviewer'
}

interface CommitDiffTotals {
  added: number; removed: number
  files: PersonalCommitFile[]
}

interface CachedCommitDiff extends CommitDiffTotals { sha: string }

function localDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function localMonth(value: string | Date): string {
  return localDate(value).slice(0, 7)
}

function localYear(value: string | Date): string {
  return localDate(value).slice(0, 4)
}

function shiftDay(day: string, offset: number): string {
  const [year, month, date] = day.split('-').map(Number)
  return localDate(new Date(year, month - 1, date + offset))
}

function weekStart(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  const weekday = new Date(year, month - 1, date).getDay()
  return shiftDay(day, -((weekday + 6) % 7))
}

function emptyRepositoryStats(repositoryId: string, repositoryName: string, source: RepositorySource): PersonalRepositoryStats {
  return { repositoryId, repositoryName, source, commits: 0, branches: 0, added: 0, removed: 0, activeDays: 0, mrAuthored: 0, mrReviewed: 0 }
}

export class UserActivityService {
  constructor(
    private readonly storage: StorageService,
    private readonly gitlab: GitLabService,
    private readonly repositoryService: RepositoryService,
    private readonly branchService: BranchService,
    private readonly namingService: NamingService
  ) {}

  async getActivity(session: UserSession, months: number = 6): Promise<PersonalActivity> {
    const accessToken = session.gitlabToken
    if (!accessToken) throw new Error('请先使用 Access Token 登录后再查看个人活动。')
    const normalizedMonths = Math.max(1, Math.min(Number(months) || 6, 36))
    const email = session.email.toLowerCase().trim()
    const repos = this.repositoryService.list()
    const since = new Date()
    since.setHours(0, 0, 0, 0)
    since.setDate(1)
    since.setMonth(since.getMonth() - normalizedMonths + 1)
    const sinceIso = since.toISOString()

    const { commits, details } = await this.collectCommits(session, email, repos, sinceIso, accessToken, normalizedMonths)
    const mergeRequests = await this.collectMergeRequests(session, repos, sinceIso, accessToken, normalizedMonths)
    const stats = this.buildStats(session, commits, details, mergeRequests, repos, normalizedMonths)
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    const branches = this.branchService.listBranches().filter((branch) => matchesUserToCreator(
      session, branch.creator, repoById.get(branch.repositoryId)?.source ?? 'local'
    )).map((branch) => ({
      repositoryId: branch.repositoryId,
      repositoryName: repoById.get(branch.repositoryId)?.name ?? branch.repositoryId,
      name: branch.name, type: branch.type, createdAt: branch.createdAt
    }))
    return { commits, mergeRequests, stats, commitDetails: details, branches }
  }

  async getCommitFile(session: UserSession, repositoryId: string, sha: string, path: string): Promise<string> {
    const repository = this.repositoryService.list().find((repo) => repo.id === repositoryId)
    if (!repository || !repository.gitlabProjectId || !['gitlab', 'github', 'gitee'].includes(repository.source)) {
      throw new Error('远程仓库不存在或不支持读取文件。')
    }
    const accessToken = session.gitlabToken
    if (!accessToken) throw new Error('请先使用 Access Token 登录。')
    if (!sha || sha.length > 128 || !path || path.length > 2048 || path.startsWith('/') || path.split('/').some((part) => part === '..')) {
      throw new Error('提交或文件路径无效。')
    }
    return this.gitlab.getCommitFile(Number(repository.gitlabProjectId), sha, path, {
      apiKey: accessToken,
      url: repository.gitlabUrl,
      provider: repository.source as RemoteRepositorySource,
      projectPath: repository.remoteProjectPath
    })
  }

  private async collectCommits(
    session: UserSession,
    email: string,
    repos: Repository[],
    sinceIso: string,
    gitlabToken: string,
    months: number
  ): Promise<{ commits: PersonalCommit[]; details: PersonalActivity['commitDetails'] }> {
    const forgeAccount = { id: session.gitlabUserId, username: session.username.trim().toLowerCase() }
    const cacheKind = `commits:${months}m`
    const cached = this.loadCache<CachedCommit>(session.email, cacheKind)
    const legacyCached = this.loadCache<CachedCommit>(session.email, 'commits')
    const results: PersonalCommit[] = []
    const linesBySha = new Map<string, CommitDiffTotals>()
    const diffStatus = new Map<string, 'loaded' | 'failed'>()
    for (const repo of repos) {
      if ((repo.source !== 'gitlab' && repo.source !== 'github' && repo.source !== 'gitee') || !repo.gitlabProjectId) continue
      let rows = cached.get(repo.id) ?? legacyCached.get(repo.id) ?? []
      try {
        const account = session.source === repo.source ? forgeAccount : undefined
        const fresh = await this.fetchCommits(repo, email, sinceIso, gitlabToken, account)
        const merged = new Map(rows.map((row) => [row.sha, row]))
        for (const row of fresh) merged.set(row.sha, row)
        rows = [...merged.values()].filter((row) => row.committedAt >= sinceIso)
        rows.sort((a, b) => b.committedAt.localeCompare(a.committedAt))
        this.saveCache(session.email, repo.id, cacheKind, rows)
      } catch (error) {
        rows = rows.filter((row) => row.committedAt >= sinceIso)
        logger.warn(`Commit list lookup failed for ${repo.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const c of rows) {
        results.push({ ...c, repositoryId: repo.id, repositoryName: repo.name, source: repo.source })
      }
    }
    results.sort((a, b) => b.committedAt.localeCompare(a.committedAt))
    const cachedDiffs = this.loadCache<CachedCommitDiff>(session.email, 'commit_diffs:v2')
    let diffsChanged = false
    // 逐 commit 统计代码行数；单个失败不影响整体统计。
    for (const repo of repos) {
      if ((repo.source !== 'gitlab' && repo.source !== 'github' && repo.source !== 'gitee') || !repo.gitlabProjectId) continue
      const shas = results.filter((c) => c.repositoryId === repo.id).map((c) => c.sha)
      const cachedBySha = new Map((cachedDiffs.get(repo.id) ?? []).map((d) => [d.sha, d]))
      for (const sha of shas) {
        const cacheKey = `${repo.id}:${sha}`
        const cached = cachedBySha.get(sha)
        if (cached) {
          linesBySha.set(cacheKey, { added: cached.added, removed: cached.removed, files: cached.files })
          diffStatus.set(cacheKey, 'loaded')
          continue
        }
        try {
          const details = await this.gitlab.commitDiffDetails(repo.gitlabProjectId, sha, { apiKey: gitlabToken, url: repo.gitlabUrl, provider: repo.source as 'gitlab' | 'github' | 'gitee', projectPath: repo.remoteProjectPath })
          linesBySha.set(cacheKey, {
            added: details.reduce((sum, file) => sum + file.added, 0),
            removed: details.reduce((sum, file) => sum + file.removed, 0),
            files: details
          })
          diffStatus.set(cacheKey, 'loaded')
          diffsChanged = true
        } catch (error) {
          diffStatus.set(cacheKey, 'failed')
          logger.error(`Commit diff lookup failed for ${repo.name}@${sha}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    if (diffsChanged) {
      const shasByProject = new Map<string, string[]>()
      for (const repo of repos) {
        if (!repo.gitlabProjectId) continue
        shasByProject.set(
          repo.id,
          results.filter((c) => c.repositoryId === repo.id).map((c) => c.sha)
        )
      }
      this.saveCommitDiffCache(session.email, shasByProject, linesBySha)
    }
    const details = results.map((commit) => ({
      sha: commit.sha,
      repositoryId: commit.repositoryId,
      added: linesBySha.get(`${commit.repositoryId}:${commit.sha}`)?.added ?? 0,
      removed: linesBySha.get(`${commit.repositoryId}:${commit.sha}`)?.removed ?? 0,
      diffStatus: diffStatus.get(`${commit.repositoryId}:${commit.sha}`) ?? 'failed',
      files: linesBySha.get(`${commit.repositoryId}:${commit.sha}`)?.files ?? []
    }))
    return { commits: results, details }
  }

  private async fetchCommits(
    repo: Repository,
    email: string,
    since: string,
    gitlabToken: string,
    account?: { id?: number | null; username?: string }
  ): Promise<CachedCommit[]> {
    const rows = await this.gitlab.listProjectCommits(
      Number(repo.gitlabProjectId),
      email,
      since,
      { apiKey: gitlabToken, url: repo.gitlabUrl, provider: repo.source as RemoteRepositorySource, projectPath: repo.remoteProjectPath },
      account
    )
    return rows.map((r) => ({
        sha: String(r.id ?? ''),
        shortSha: String(r.short_id ?? String(r.id ?? '').slice(0, 8)),
        subject: String(r.title ?? ''),
        committedAt: String(r.committed_date ?? r.created_at ?? ''),
        webUrl: String(r.web_url ?? '')
      })).filter((row) => row.sha && row.committedAt)
  }

  private async collectMergeRequests(session: UserSession, repos: Repository[], sinceIso: string, gitlabToken: string, months: number): Promise<PersonalMergeRequest[]> {
    const results: PersonalMergeRequest[] = []
    const cacheKind = `mrs:${months}m`
    const cachedByRepo = this.loadCache<CachedMergeRequest>(session.email, cacheKind)
    const legacyCached = this.loadCache<CachedMergeRequest>(session.email, 'mrs')
    for (const repo of repos) {
      if ((repo.source !== 'gitlab' && repo.source !== 'github' && repo.source !== 'gitee') || !repo.gitlabProjectId) continue
      const previous = cachedByRepo.get(repo.id) ?? legacyCached.get(repo.id) ?? []
      const rowsByRole = new Map(previous.map((row) => [`${row.id}:${row.role}`, row]))
      const fetched = await this.fetchMergeRequests(repo, session, sinceIso, gitlabToken)
      let succeeded = false
      for (const role of ['author', 'reviewer'] as const) {
        if (fetched[role] === null) continue
        succeeded = true
        for (const [key, row] of rowsByRole) {
          if (row.role === role) rowsByRole.delete(key)
        }
        for (const mr of fetched[role] ?? []) rowsByRole.set(`${mr.id}:${role}`, mr)
      }
      let rows = [...rowsByRole.values()].filter((r) => r.createdAt >= sinceIso)
      const authored = new Set(rows.filter((r) => r.role === 'author').map((r) => r.id))
      rows = rows.filter((r) => r.role !== 'reviewer' || !authored.has(r.id))
      if (succeeded) this.saveCache(session.email, repo.id, cacheKind, rows)
      for (const mr of rows) {
        results.push({ ...mr, repositoryId: repo.id, repositoryName: repo.name, source: repo.source })
      }
    }
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return results
  }

  private async fetchMergeRequests(repo: Repository, session: UserSession, since: string, gitlabToken: string): Promise<Record<'author' | 'reviewer', CachedMergeRequest[] | null>> {
    if (session.source !== repo.source) return { author: null, reviewer: null }
    const userId = session.gitlabUserId ?? Number(session.accountId ?? 0)
    if (!userId) return { author: null, reviewer: null }
    const out: Record<'author' | 'reviewer', CachedMergeRequest[] | null> = { author: null, reviewer: null }
    for (const role of ['author', 'reviewer'] as const) {
      try {
        const rows = await this.gitlab.listProjectMergeRequests(Number(repo.gitlabProjectId), userId, role, since, { apiKey: gitlabToken, url: repo.gitlabUrl, provider: repo.source as RemoteRepositorySource, projectPath: repo.remoteProjectPath }, session.username)
        out[role] = rows.map((r) => ({
            id: Number(r.id ?? 0),
            iid: Number(r.iid ?? 0),
            title: String(r.title ?? ''),
            state: String(r.state ?? ''),
            sourceBranch: String(r.source_branch ?? ''),
            targetBranch: String(r.target_branch ?? ''),
            createdAt: String(r.created_at ?? ''),
            webUrl: String(r.web_url ?? ''),
            role
          })).filter((row) => row.id && row.createdAt >= since)
      } catch (error) {
        logger.warn(`${role} merge request lookup failed for ${repo.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return out
  }

  private buildStats(
    session: UserSession,
    commits: PersonalCommit[],
    details: PersonalActivity['commitDetails'],
    mergeRequests: PersonalMergeRequest[],
    repos: Repository[],
    months: number
  ): PersonalStats {
    const allBranches = this.branchService.listBranches()
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    const myBranches = allBranches.filter((branch) => matchesUserToCreator(
      session,
      branch.creator,
      repoById.get(branch.repositoryId)?.source ?? 'local'
    ))
    const validBranches = myBranches.filter((b) => b.naming.status === 'valid' || b.naming.status === 'excluded').length
    const invalidBranches = myBranches.filter((b) => b.naming.status === 'invalid').length

    const monthMap = new Map<string, { commits: number; branches: number }>()
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() - i)
      monthMap.set(localMonth(d), { commits: 0, branches: 0 })
    }
    for (const c of commits) {
      const m = localMonth(c.committedAt)
      const entry = monthMap.get(m)
      if (entry) entry.commits += 1
    }
    for (const b of myBranches) {
      const created = b.createdAt ?? ''
      if (!created) continue
      const m = localMonth(created)
      const entry = monthMap.get(m)
      if (entry) entry.branches += 1
    }
    const byRepoMap = new Map<string, PersonalRepositoryStats>()
    for (const c of commits) {
      const entry = byRepoMap.get(c.repositoryId) ?? emptyRepositoryStats(c.repositoryId, c.repositoryName, c.source)
      entry.commits += 1
      byRepoMap.set(c.repositoryId, entry)
    }
    for (const b of myBranches) {
      const entry = byRepoMap.get(b.repositoryId) ?? emptyRepositoryStats(
        b.repositoryId,
        b.repositoryName,
        repoById.get(b.repositoryId)?.source ?? 'local'
      )
      entry.branches += 1
      byRepoMap.set(b.repositoryId, entry)
    }

    const commitTotals = new Map<string, PersonalActivity['commitDetails'][number]>()
    for (const detail of details) commitTotals.set(`${detail.repositoryId}:${detail.sha}`, detail)
    const linesAdded = [...commitTotals.values()].filter((v) => v.diffStatus === 'loaded').reduce((sum, v) => sum + v.added, 0)
    const linesRemoved = [...commitTotals.values()].filter((v) => v.diffStatus === 'loaded').reduce((sum, v) => sum + v.removed, 0)
    const linesByRepository = new Map<string, { repositoryId: string; repositoryName: string; added: number; removed: number }>()
    for (const commit of commits) {
      const totals = commitTotals.get(`${commit.repositoryId}:${commit.sha}`)
      if (!totals) continue
      const entry = linesByRepository.get(commit.repositoryId) ?? {
        repositoryId: commit.repositoryId,
        repositoryName: commit.repositoryName,
        added: 0,
        removed: 0
      }
      entry.added += totals.added
      entry.removed += totals.removed
      linesByRepository.set(commit.repositoryId, entry)
      const repoStats = byRepoMap.get(commit.repositoryId)
      if (repoStats) {
        repoStats.added += totals.added
        repoStats.removed += totals.removed
      }
    }
    const commitDays = new Set(commits.map((c) => localDate(c.committedAt)).filter(Boolean))
    const streaks = this.buildStreaks(commitDays)
    const weekdays = [0, 0, 0, 0, 0, 0, 0]
    const hours = Array.from({ length: 24 }, () => 0)
    for (const commit of commits) {
      const at = new Date(commit.committedAt)
      if (!Number.isNaN(at.getTime())) {
        weekdays[at.getDay()] += 1
        hours[at.getHours()] += 1
      }
    }
    const monthlyLines = [...monthMap.keys()].map((month) => {
      const matched = commits
        .filter((c) => localMonth(c.committedAt) === month)
        .map((c) => commitTotals.get(`${c.repositoryId}:${c.sha}`))
        .filter((v): v is NonNullable<typeof v> => Boolean(v))
      return {
        month,
        added: matched.reduce((sum, v) => sum + v.added, 0),
        removed: matched.reduce((sum, v) => sum + v.removed, 0)
      }
    })
    const fileTypeMap = new Map<string, { type: string; files: number; added: number; removed: number }>()
    const fileMap = new Map<string, { path: string; commits: number; added: number; removed: number }>()
    for (const detail of commitTotals.values()) {
      if (detail.diffStatus !== 'loaded') continue
      for (const file of detail.files) {
        const type = file.path.includes('.') ? file.path.split('.').pop()!.toLowerCase() : '(no ext)'
        const typeEntry = fileTypeMap.get(type) ?? { type, files: 0, added: 0, removed: 0 }
        typeEntry.files += 1
        typeEntry.added += file.added
        typeEntry.removed += file.removed
        fileTypeMap.set(type, typeEntry)
        const fileEntry = fileMap.get(file.path) ?? { path: file.path, commits: 0, added: 0, removed: 0 }
        fileEntry.commits += 1
        fileEntry.added += file.added
        fileEntry.removed += file.removed
        fileMap.set(file.path, fileEntry)
      }
    }
    const yearStats = new Map<string, PersonalYearStats>()
    const getYear = (year: string): PersonalYearStats => {
      let entry = yearStats.get(year)
      if (!entry) {
        entry = { year, commits: 0, branches: 0, added: 0, removed: 0, activeDays: 0, mrAuthored: 0, mrReviewed: 0 }
        yearStats.set(year, entry)
      }
      return entry
    }
    const daysByYear = new Map<string, Set<string>>()
    for (const commit of commits) {
      const year = localYear(commit.committedAt)
      if (!year) continue
      getYear(year).commits += 1
      const day = localDate(commit.committedAt)
      const days = daysByYear.get(year) ?? new Set<string>()
      if (day) days.add(day)
      daysByYear.set(year, days)
      const detail = commitTotals.get(`${commit.repositoryId}:${commit.sha}`)
      if (detail?.diffStatus === 'loaded') {
        getYear(year).added += detail.added
        getYear(year).removed += detail.removed
      }
    }
    for (const branch of myBranches) {
      const year = branch.createdAt ? localYear(branch.createdAt) : ''
      if (year) getYear(year).branches += 1
    }
    for (const mr of mergeRequests) {
      const year = localYear(mr.createdAt)
      if (!year) continue
      const entry = getYear(year)
      if (mr.role === 'author') entry.mrAuthored += 1
      else entry.mrReviewed += 1
      const repoStats = byRepoMap.get(mr.repositoryId)
      if (repoStats) {
        if (mr.role === 'author') repoStats.mrAuthored += 1
        else repoStats.mrReviewed += 1
      }
    }
    for (const [year, days] of daysByYear) getYear(year).activeDays = days.size

    const sourceStats = new Map<RepositorySource, PersonalSourceStats>()
    const getSource = (source: RepositorySource): PersonalSourceStats => {
      let entry = sourceStats.get(source)
      if (!entry) {
        entry = { source, commits: 0, branches: 0, added: 0, removed: 0, mrAuthored: 0, mrReviewed: 0 }
        sourceStats.set(source, entry)
      }
      return entry
    }
    for (const commit of commits) {
      const entry = getSource(commit.source)
      entry.commits += 1
      const detail = commitTotals.get(`${commit.repositoryId}:${commit.sha}`)
      if (detail?.diffStatus === 'loaded') {
        entry.added += detail.added
        entry.removed += detail.removed
      }
    }
    for (const branch of myBranches) getSource(repoById.get(branch.repositoryId)?.source ?? 'local').branches += 1
    for (const mr of mergeRequests) {
      const entry = getSource(mr.source)
      if (mr.role === 'author') entry.mrAuthored += 1
      else entry.mrReviewed += 1
    }
    const daysByRepository = new Map<string, Set<string>>()
    for (const commit of commits) {
      const day = localDate(commit.committedAt)
      const days = daysByRepository.get(commit.repositoryId) ?? new Set<string>()
      if (day) days.add(day)
      daysByRepository.set(commit.repositoryId, days)
    }
    for (const [repositoryId, days] of daysByRepository) {
      const entry = byRepoMap.get(repositoryId)
      if (entry) entry.activeDays = days.size
    }

    return {
      commitCount: commits.length,
      linesAdded,
      linesRemoved,
      netLines: linesAdded - linesRemoved,
      linesAddedByRepository: [...linesByRepository.values()],
      branchCount: myBranches.length,
      validBranches,
      invalidBranches,
      repositoryCount: new Set([...commits.map((commit) => commit.repositoryId), ...myBranches.map((branch) => branch.repositoryId)]).size,
      months: [...monthMap.entries()].map(([month, v]) => ({ month, ...v })),
      years: [...yearStats.values()].sort((a, b) => a.year.localeCompare(b.year)),
      bySource: [...sourceStats.values()].sort((a, b) => a.source.localeCompare(b.source)),
      byRepository: [...byRepoMap.values()].sort((a, b) => b.commits - a.commits || b.branches - a.branches),
      activeDays: commitDays.size,
      activeWeeks: new Set([...commitDays].map(weekStart)).size,
      averageCommitsPerActiveDay: commitDays.size ? Number((commits.length / commitDays.size).toFixed(2)) : 0,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
      weekdays,
      hours,
      monthlyLines,
      fileTypes: [...fileTypeMap.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed)),
      topFiles: [...fileMap.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed)).slice(0, 8),
      mrAuthored: mergeRequests.filter((mr) => mr.role === 'author').length,
      mrReviewed: mergeRequests.filter((mr) => mr.role === 'reviewer').length,
      diffsLoaded: details.filter((detail) => detail.diffStatus === 'loaded').length,
      diffsFailed: details.filter((detail) => detail.diffStatus === 'failed').length
    }
  }

  private buildStreaks(days: Set<string>): { current: number; longest: number } {
    const dates = [...days].sort()
    let longest = 0
    let run = 0
    for (let i = 0; i < dates.length; i += 1) {
      if (i === 0 || shiftDay(dates[i - 1]!, 1) === dates[i]) {
        run += 1
      }
      else {
        run = 1
      }
      longest = Math.max(longest, run)
    }
    const today = localDate(new Date())
    const yesterday = shiftDay(today, -1)
    let current = 0
    if (dates.length && (dates.at(-1) === today || dates.at(-1) === yesterday)) {
      current = 1
      for (let i = dates.length - 1; i > 0; i -= 1) {
        if (shiftDay(dates[i - 1]!, 1) === dates[i]) current += 1
        else break
      }
    }
    return { current, longest }
  }

  private saveCommitDiffCache(
    email: string,
    shasByRepository: Map<string, string[]>,
    linesBySha: Map<string, CommitDiffTotals>
  ): void {
    const existingByRepository = this.loadCache<CachedCommitDiff>(email, 'commit_diffs:v2')
    for (const [repositoryId, shas] of shasByRepository.entries()) {
      const rowsBySha = new Map((existingByRepository.get(repositoryId) ?? []).map((row) => [row.sha, row]))
      for (const sha of shas) {
        const totals = linesBySha.get(`${repositoryId}:${sha}`)
        if (totals) rowsBySha.set(sha, { sha, ...totals })
      }
      this.saveCache(email, repositoryId, 'commit_diffs:v2', [...rowsBySha.values()])
    }
  }

  private loadCache<T>(email: string, kind: string): Map<string, T[]> {
    const rows = this.storage.all<{ repository_id: string; data_json: string }>(
      'SELECT repository_id, data_json FROM user_activity_cache WHERE email = ? AND kind = ?',
      [email.toLowerCase().trim(), kind]
    )
    const map = new Map<string, T[]>()
    for (const r of rows) {
      try { map.set(r.repository_id, JSON.parse(r.data_json) as T[]) } catch { /* skip bad cache */ }
    }
    return map
  }

  private saveCache(email: string, repositoryId: string, kind: string, data: unknown): void {
    const normalized = email.toLowerCase().trim()
    const existing = this.storage.get<{ id: string }>(
      'SELECT id FROM user_activity_cache WHERE email = ? AND repository_id = ? AND kind = ?',
      [normalized, repositoryId, kind]
    )
    const payload = JSON.stringify(data)
    if (existing) {
      this.storage.update('user_activity_cache', { data_json: payload, fetched_at: new Date().toISOString() }, 'id = ?', [existing.id])
    } else {
      this.storage.insert('user_activity_cache', {
        email: normalized, repository_id: repositoryId, kind, data_json: payload, fetched_at: new Date().toISOString()
      })
    }
  }

  clearCache(): void {
    this.storage.run('DELETE FROM user_activity_cache')
  }
}
