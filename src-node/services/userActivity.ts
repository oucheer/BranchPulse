import type { StorageService } from './storage'
import type { GitLabService } from './gitlab'
import type { RepositoryService } from './repository'
import type { BranchService } from './branch'
import type { NamingService } from './naming'
import type {
  PersonalActivity, PersonalCommit, PersonalMergeRequest, PersonalStats, Repository, UserSession
} from '@shared/types'

const MONTHS_6 = 6
const MONTHS_12 = 12

interface CachedCommit { sha: string; shortSha: string; subject: string; committedAt: string; webUrl?: string }
interface CachedMergeRequest {
  id: number; iid: number; title: string; state: string
  sourceBranch: string; targetBranch: string; createdAt: string; webUrl?: string; role: 'author' | 'reviewer'
}

interface CommitDiffTotals { added: number; removed: number }

export class UserActivityService {
  private lastCommitDiffs = new Map<string, CommitDiffTotals>()

  constructor(
    private readonly storage: StorageService,
    private readonly gitlab: GitLabService,
    private readonly repositoryService: RepositoryService,
    private readonly branchService: BranchService,
    private readonly namingService: NamingService
  ) {}

  async getActivity(session: UserSession, months: number = 6): Promise<PersonalActivity> {
    const normalizedMonths = Math.max(1, Math.min(Number(months) || 6, 36))
    const email = session.email.toLowerCase().trim()
    const repos = this.repositoryService.list()
    const since = new Date()
    since.setMonth(since.getMonth() - normalizedMonths)
    const sinceIso = since.toISOString()

    const commits = await this.collectCommits(session, email, repos, sinceIso)
    const mergeRequests = await this.collectMergeRequests(session, repos, sinceIso)
    const stats = this.buildStats(session, commits, mergeRequests, repos, normalizedMonths)
    return { commits, mergeRequests, stats }
  }

  private async collectCommits(session: UserSession, email: string, repos: Repository[], sinceIso: string): Promise<PersonalCommit[]> {
    const cached = this.loadCache<CachedCommit>(session.email, 'commits')
    const results: PersonalCommit[] = []
    const linesBySha = new Map<string, { added: number; removed: number }>()
    for (const repo of repos) {
      if (repo.source !== 'gitlab' || !repo.gitlabProjectId) continue
      const key = String(repo.gitlabProjectId)
      let rows = cached.get(key) ?? []
      const lastFetched = rows.length > 0 ? rows[0].committedAt : sinceIso
      const fresh = await this.fetchCommits(repo.gitlabProjectId, email, lastFetched, repo.id, repo.name)
      if (fresh.length > 0) {
        const existing = new Set(rows.map((r) => r.sha))
        for (const c of fresh) if (!existing.has(c.sha)) rows.push(c)
        rows = rows.filter((r) => r.committedAt >= sinceIso)
        rows.sort((a, b) => b.committedAt.localeCompare(a.committedAt))
        this.saveCache(session.email, repo.id, 'commits', rows)
      }
      for (const c of rows) {
        results.push({ ...c, repositoryId: repo.id, repositoryName: repo.name })
      }
    }
    results.sort((a, b) => b.committedAt.localeCompare(a.committedAt))
    // 逐 commit 统计代码行数；单个失败不影响整体统计。
    for (const repo of repos) {
      if (repo.source !== 'gitlab' || !repo.gitlabProjectId) continue
      const shas = results.filter((c) => c.repositoryId === repo.id).map((c) => c.sha)
      for (const sha of shas) {
        try {
          linesBySha.set(sha, await this.gitlab.commitDiffTotals(repo.gitlabProjectId, sha))
        } catch {
          linesBySha.set(sha, { added: 0, removed: 0 })
        }
      }
    }
    this.lastCommitDiffs = linesBySha
    return results
  }

  private async fetchCommits(projectId: number, email: string, since: string, repositoryId: string, repositoryName: string): Promise<CachedCommit[]> {
    try {
      const rows = await this.gitlab.listProjectCommits(projectId, email, since)
      return rows.map((r) => ({
        sha: String(r.id ?? ''),
        shortSha: String(r.short_id ?? String(r.id ?? '').slice(0, 8)),
        subject: String(r.title ?? ''),
        committedAt: String(r.committed_date ?? r.created_at ?? ''),
        webUrl: String(r.web_url ?? '')
      }))
    } catch {
      return []
    }
  }

  private async collectMergeRequests(session: UserSession, repos: Repository[], sinceIso: string): Promise<PersonalMergeRequest[]> {
    const results: PersonalMergeRequest[] = []
    for (const repo of repos) {
      if (repo.source !== 'gitlab' || !repo.gitlabProjectId) continue
      const key = String(repo.gitlabProjectId)
      let rows = this.loadCache<CachedMergeRequest>(session.email, 'mrs').get(key) ?? []
      const fresh = await this.fetchMergeRequests(repo.gitlabProjectId, session.gitlabUserId, sinceIso)
      if (fresh.length > 0) {
        const existing = new Set(rows.map((r) => `${r.id}:${r.role}`))
        for (const mr of fresh) if (!existing.has(`${mr.id}:${mr.role}`)) rows.push(mr)
        rows = rows.filter((r) => r.createdAt >= sinceIso)
        this.saveCache(session.email, repo.id, 'mrs', rows)
      }
      for (const mr of rows) {
        results.push({ ...mr, repositoryId: repo.id, repositoryName: repo.name })
      }
    }
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return results
  }

  private async fetchMergeRequests(projectId: number, userId: number | null, since: string): Promise<CachedMergeRequest[]> {
    if (!userId) return []
    const out: CachedMergeRequest[] = []
    for (const role of ['author', 'reviewer'] as const) {
      try {
        const rows = await this.gitlab.listProjectMergeRequests(projectId, userId, role, since)
        for (const r of rows) {
          out.push({
            id: Number(r.id ?? 0),
            iid: Number(r.iid ?? 0),
            title: String(r.title ?? ''),
            state: String(r.state ?? ''),
            sourceBranch: String(r.source_branch ?? ''),
            targetBranch: String(r.target_branch ?? ''),
            createdAt: String(r.created_at ?? ''),
            webUrl: String(r.web_url ?? ''),
            role
          })
        }
      } catch { /* skip this repo/role */ }
    }
    return out
  }

  private buildStats(session: UserSession, commits: PersonalCommit[], mrs: PersonalMergeRequest[], repos: Repository[], months: number): PersonalStats {
    const allBranches = this.branchService.listBranches()
    const email = session.email.toLowerCase().trim()
    const myBranches = allBranches.filter((b) => (b.creator?.email ?? '').toLowerCase().trim() === email)
    const validBranches = myBranches.filter((b) => b.naming.status === 'valid' || b.naming.status === 'excluded').length
    const invalidBranches = myBranches.filter((b) => b.naming.status === 'invalid').length

    const monthMap = new Map<string, { commits: number; branches: number }>()
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date()
      d.setMonth(d.getMonth() - i)
      monthMap.set(d.toISOString().slice(0, 7), { commits: 0, branches: 0 })
    }
    for (const c of commits) {
      const m = c.committedAt.slice(0, 7)
      const entry = monthMap.get(m)
      if (entry) entry.commits += 1
    }
    for (const b of myBranches) {
      const created = b.createdAt ?? ''
      if (!created) continue
      const m = created.slice(0, 7)
      const entry = monthMap.get(m)
      if (entry) entry.branches += 1
    }
    const byRepoMap = new Map<string, { repositoryId: string; repositoryName: string; commits: number; branches: number }>()
    for (const c of commits) {
      const entry = byRepoMap.get(c.repositoryId) ?? { repositoryId: c.repositoryId, repositoryName: c.repositoryName, commits: 0, branches: 0 }
      entry.commits += 1
      byRepoMap.set(c.repositoryId, entry)
    }
    for (const b of myBranches) {
      const entry = byRepoMap.get(b.repositoryId) ?? { repositoryId: b.repositoryId, repositoryName: b.repositoryName, commits: 0, branches: 0 }
      entry.branches += 1
      byRepoMap.set(b.repositoryId, entry)
    }

    const linesAdded = [...this.lastCommitDiffs.values()].reduce((sum, v) => sum + v.added, 0)
    const linesRemoved = [...this.lastCommitDiffs.values()].reduce((sum, v) => sum + v.removed, 0)
    return {
      commitCount: commits.length,
      linesAdded,
      linesRemoved,
      branchCount: myBranches.length,
      validBranches,
      invalidBranches,
      months: [...monthMap.entries()].map(([month, v]) => ({ month, ...v })),
      byRepository: [...byRepoMap.values()]
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
